/**
 * 保险库服务 —— core 的门面。
 *
 * UI 层只与这个类交互,不允许直接接触信封或明文。
 * 关键约束在这里落地:
 * - 锁定后 getEntries() 等方法直接抛错,不给调用方"忘记检查状态"的机会。
 * - 所有写操作都会重新加密整份保险库并更新审计,不存在局部明文落盘。
 * - 自动锁定由 lockAfterMs 控制,每次访问重置计时器。
 */

import {
  sealJson,
  openJson,
  generateSalt,
  deriveKey,
  assessPassword,
  type Envelope,
  type RandomSource,
  type PasswordStrength,
  defaultRandom,
} from '../crypto/primitives.js';
import {
  generateRecoveryCodes,
  verifyRecoveryCode,
  consumeRecoveryCode,
  remainingRecoveryCodes,
  type RecoveryCodeRecord,
} from '../crypto/recovery.js';
import { totpNow, verifyTotp, selfTest, type TotpCode, type VerifyResult } from '../totp.js';
import { base32Decode, base32Encode } from '../base32.js';
import {
  createEmptyVault,
  displayName,
  filterEntries,
  sortEntries,
  type VaultPlain,
} from './model.js';
import { appendAudit, makeAuditEvent, type AuditAction, type AuditEvent } from './audit.js';
import { mergeVaults, toMergeable, removeEntryWithTombstone, type MergeableVault } from '../sync/merge.js';
import { parseOtpAuthUri, type OtpEntry } from '../otpauth.js';
import { parseMigrationUri } from '../migrate/googleAuth.js';
import { timingSafeEqual } from '../crypto/primitives.js';
import type { SyncTransport, RemoteRecord } from '../adapters/platform.js';

const STORAGE_KEY = 'aegis.vault.v1';
const DEVICE_KEY = 'aegis.device.v1';
const LOCK_KEY = 'aegis.lock.v1';

export interface VaultState {
  /** 是否已解锁。 */
  unlocked: boolean;
  /** 是否已初始化过保险库。 */
  initialized: boolean;
  /** 是否已配置主密码。 */
  hasPassword: boolean;
}

export interface SyncStatus {
  lastSyncAt: number | null;
  revision: number;
  lastError: string | null;
  /** 上次合并带回来的变更条数。 */
  lastMergedCount: number;
}

export class VaultLockedError extends Error {
  constructor() {
    super('保险库已锁定,请先解锁');
    this.name = 'VaultLockedError';
  }
}

export class VaultService {
  private plain: MergeableVault | null = null;
  private password: string | null = null;
  private lockTimer: ReturnType<typeof setTimeout> | null = null;
  private revision = 0;
  private syncStatus: SyncStatus = {
    lastSyncAt: null,
    revision: 0,
    lastError: null,
    lastMergedCount: 0,
  };

  constructor(
    private readonly deps: {
      store: {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<void>;
        remove(key: string): Promise<void>;
      };
      deviceId: string;
      deviceName: string;
      now(): number;
      random: RandomSource;
      transport?: SyncTransport;
      /** 自动锁定时长,默认 5 分钟。设为 0 禁用。 */
      lockAfterMs?: number;
      /**
       * PBKDF2 迭代次数覆盖。仅供测试使用(测试跑 40+ 次加解密,
       * 按生产值 21 万次需 20 秒以上)。生产环境不要传这个参数。
       */
      kdfIterations?: number;
    },
  ) {}

  // ---------- 生命周期 ----------

  /** 启动时调用,读取本地状态。 */
  async init(): Promise<VaultState> {
    // 自检失败意味着基础运算有问题,此时继续运行只会产出错误验证码,
    // 所以直接抛错阻断,好过让用户对着永远不对的码反复尝试。
    if (!selfTest()) {
      throw new Error('TOTP 引擎自检失败,已中止启动以避免生成错误验证码');
    }
    await this.loadRevision();
    const record = await this.deps.store.get(STORAGE_KEY);
    return {
      unlocked: false,
      initialized: record !== null,
      hasPassword: record !== null,
    };
  }

  private get lockAfterMs(): number {
    return this.deps.lockAfterMs ?? 5 * 60 * 1000;
  }

  /**
   * 加密保险库。测试通过 kdfIterations 降低迭代以提速,
   * 生产走默认的 21 万次。
   */
  private sealVault(value: unknown, password: string): Envelope {
    return sealJson(value, password, this.deps.random, this.deps.kdfIterations);
  }

  /** 解密保险库。测试用了低迭代参数,故需一并放行弱 KDF 检查。 */
  private openVault<T>(envelope: Envelope, password: string): T {
    return openJson<T>(envelope, password, this.deps.kdfIterations !== undefined);
  }

  private resetLockTimer(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (this.lockAfterMs <= 0 || this.plain === null) return;
    this.lockTimer = setTimeout(() => {
      void this.lock();
    }, this.lockAfterMs);
  }

  /** 是否已解锁。 */
  isUnlocked(): boolean {
    return this.plain !== null;
  }

  async hasVault(): Promise<boolean> {
    return (await this.deps.store.get(STORAGE_KEY)) !== null;
  }

  async getDeviceName(): Promise<string> {
    return this.deps.deviceName;
  }

  // ---------- 创建与解锁 ----------

  assessPassword(password: string): PasswordStrength {
    return assessPassword(password);
  }

  /** 首次创建保险库。 */
  /** 首次创建保险库。返回明文恢复码,仅此一次可见。 */
  async create(password: string, confirm: string): Promise<string[]> {
    if (this.plain) throw new Error('保险库已存在');
    if (password !== confirm) throw new Error('两次输入的主密码不一致');
    const strength = assessPassword(password);
    if (strength.score < 1) throw new Error(strength.hint);

    const now = this.deps.now();
    const empty = createEmptyVault(this.deps.deviceId, now);
    const recovery = generateRecoveryCodes(undefined, this.deps.random);

    this.plain = toMergeable({
      ...empty,
      recoveryCodes: recovery.records,
      auditLog: [makeAuditEvent({ action: 'vault.create', detail: this.deps.deviceName, at: now })],
    });
    this.password = password;

    await this.persist();
    return recovery.plaintext;
  }

  /** 解锁。 */
  async unlock(password: string): Promise<void> {
    const raw = await this.deps.store.get(STORAGE_KEY);
    if (!raw) throw new Error('尚未创建保险库');

    const record = JSON.parse(raw) as { envelope: Envelope; revision: number; updatedAt: number; deviceId: string };
    const plain = this.openVault<VaultPlain>(record.envelope, password);

    this.plain = toMergeable(plain);
    this.password = password;
    this.revision = record.revision ?? 0;
    this.syncStatus.revision = this.revision;

    this.audit({ action: 'vault.unlock', detail: this.deps.deviceName });
    this.resetLockTimer();
  }

  /** 锁定,清除内存中的明文与密码。 */
  async lock(): Promise<void> {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = null;
    this.plain = null;
    this.password = null;
  }

  // ---------- 持久化 ----------

  private requireUnlocked(): MergeableVault {
    if (!this.plain) throw new VaultLockedError();
    // 每次访问都重置计时,让"正在使用"就不会被锁
    this.resetLockTimer();
    return this.plain;
  }

  private requirePassword(): string {
    if (!this.password) throw new VaultLockedError();
    return this.password;
  }

  private async persist(): Promise<void> {
    const vault = this.requireUnlocked();
    const password = this.requirePassword();
    const now = this.deps.now();
    vault.updatedAt = now;
    vault.lastDeviceId = this.deps.deviceId;

    const envelope = this.sealVault(vault, password);
    const record = {
      schemaVersion: 1 as const,
      envelope,
      updatedAt: now,
      deviceId: this.deps.deviceId,
      revision: this.revision,
    };
    await this.deps.store.set(STORAGE_KEY, JSON.stringify(record));
    await this.storeRevision(this.revision);
  }

  private async loadRevision(): Promise<void> {
    const raw = await this.deps.store.get(LOCK_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { revision: number; lastSyncAt: number | null; lastError: string | null; lastMergedCount: number };
      this.revision = parsed.revision ?? 0;
      this.syncStatus = {
        lastSyncAt: parsed.lastSyncAt ?? null,
        revision: this.revision,
        lastError: parsed.lastError ?? null,
        lastMergedCount: parsed.lastMergedCount ?? 0,
      };
    } catch {
      // 元数据损坏不致命,重新同步即可
    }
  }

  private async storeRevision(revision: number): Promise<void> {
    this.syncStatus = { ...this.syncStatus, revision };
    await this.deps.store.set(
      LOCK_KEY,
      JSON.stringify({
        revision,
        lastSyncAt: this.syncStatus.lastSyncAt,
        lastError: this.syncStatus.lastError,
        lastMergedCount: this.syncStatus.lastMergedCount,
      }),
    );
  }

  private audit(input: { action: AuditAction; entryId?: string | null; detail?: string; outcome?: AuditEvent['outcome'] }): void {
    if (!this.plain) return;
    this.plain.auditLog = appendAudit(this.plain.auditLog, makeAuditEvent({ ...input, at: this.deps.now() }));
  }

  // ---------- 条目 ----------

  listEntries(query = ''): OtpEntry[] {
    const vault = this.requireUnlocked();
    return filterEntries(vault.entries, query);
  }

  getEntry(id: string): OtpEntry | null {
    const vault = this.requireUnlocked();
    return vault.entries.find((entry) => entry.id === id) ?? null;
  }

  /** 通过扫码文本添加。支持 otpauth:// 与 GA 迁移链接。 */
  async addFromScanned(text: string): Promise<OtpEntry[]> {
    this.requireUnlocked();
    const trimmed = text.trim();

    if (/^otpauth-migration:\/\//i.test(trimmed)) {
      const entries = parseMigrationUri(trimmed, this.deps.now());
      const vault = this.requireUnlocked();
      const existing = new Set(vault.entries.map((e) => `${e.issuer}|${e.account}`));
      const fresh = entries.filter((e) => !existing.has(`${e.issuer}|${e.account}`));
      vault.entries.push(...fresh);
      this.audit({
        action: 'entry.migrate',
        detail: `导入 ${fresh.length} 个条目,跳过 ${entries.length - fresh.length} 个重复`,
      });
      await this.persist();
      return fresh;
    }

    const entry = parseOtpAuthUri(trimmed, this.deps.now(), this.deps.random);
    const vault = this.requireUnlocked();
    vault.entries.push(entry);
    this.audit({ action: 'entry.add', entryId: entry.id, detail: displayName(entry) });
    await this.persist();
    return [entry];
  }

  /** 手动添加。 */
  async addManual(input: {
    issuer: string;
    account: string;
    secret: string;
    algorithm?: 'SHA1' | 'SHA256' | 'SHA512';
    digits?: number;
    period?: number;
  }): Promise<OtpEntry> {
    this.requireUnlocked();
    const issuer = input.issuer.trim();
    const account = input.account.trim();
    if (!issuer) throw new Error('请填写服务名称');
    if (!account) throw new Error('请填写账户');

    // 立即验证种子能否解出合法的字节长度,提前拦截手误
    const secret = input.secret.replace(/\s+/g, '').toUpperCase();
    const bytes = base32Decode(secret);
    if (bytes.length < 10) {
      throw new Error('种子长度不足,常见原因是输入错误');
    }

    const entry: OtpEntry = {
      // 用注入的加密随机源而非 Math.random:两台设备若在同一毫秒内添加条目
      // 而id 撞了,合并时会被当成同一个元素,其中一条数据静默丢失。
      id: `man-${this.deps.now().toString(36)}-${base32Encode(this.deps.random(10))
        .replace(/=+$/, '')
        .toLowerCase()}`,
      issuer,
      account,
      secret,
      algorithm: input.algorithm ?? 'SHA1',
      digits: input.digits ?? 6,
      period: input.period ?? 30,
      createdAt: this.deps.now(),
      updatedAt: this.deps.now(),
    };

    const vault = this.requireUnlocked();
    vault.entries.push(entry);
    this.audit({ action: 'entry.add', entryId: entry.id, detail: displayName(entry) });
    await this.persist();
    return entry;
  }

  async removeEntry(id: string): Promise<void> {
    const vault = this.requireUnlocked();
    const target = vault.entries.find((e) => e.id === id);
    if (!target) throw new Error('条目不存在');
    this.plain = removeEntryWithTombstone(vault, id, this.deps.deviceId, this.deps.now());
    this.audit({ action: 'entry.remove', entryId: id, detail: displayName(target), outcome: 'success' });
    await this.persist();
  }

  async toggleFavorite(id: string): Promise<void> {
    const vault = this.requireUnlocked();
    const target = vault.entries.find((e) => e.id === id);
    if (!target) throw new Error('条目不存在');
    target.favorite = !target.favorite;
    target.updatedAt = this.deps.now();
    this.audit({ action: 'entry.favorite', entryId: id, detail: displayName(target) });
    await this.persist();
  }

  async renameEntry(id: string, patch: { account?: string; note?: string }): Promise<void> {
    const vault = this.requireUnlocked();
    const target = vault.entries.find((e) => e.id === id);
    if (!target) throw new Error('条目不存在');
    if (patch.account !== undefined) target.account = patch.account.trim();
    if (patch.note !== undefined) target.note = patch.note;
    target.updatedAt = this.deps.now();
    this.audit({ action: 'entry.rename', entryId: id, detail: displayName(target) });
    await this.persist();
  }

  // ---------- 验证码 ----------

  /**
   * 生成验证码。
   * @param withAudit 是否记审计。列表页每秒刷新一次,若每次都记会瞬间写满日志,
   *                  因此只在用户主动点击复制时才记。
   */
  generateCode(entryId: string, withAudit = false): TotpCode {
    const entry = this.getEntry(entryId);
    if (!entry) throw new Error('条目不存在');
    return totpNow(
      {
        secret: base32Decode(entry.secret),
        period: entry.period,
        digits: entry.digits,
        algorithm: entry.algorithm,
      },
      this.deps.now(),
    );
  }

  /** 批量生成,用于列表一次性渲染。 */
  generateAllCodes(): Array<{ entry: OtpEntry; code: TotpCode }> {
    const vault = this.requireUnlocked();
    return sortEntries(vault.entries).map((entry) => ({
      entry,
      code: this.generateCode(entry.id),
    }));
  }

  async recordCodeCopied(entryId: string): Promise<void> {
    const entry = this.getEntry(entryId);
    if (!entry) return;
    this.audit({ action: 'entry.code.copy', entryId, detail: displayName(entry) });
    await this.persist();
  }

  /**
   * 校验验证码。主要用于自测与未来的自动填充场景。
   * 校验本身是纯函数,不需要落盘。
   */
  verifyEntryCode(entryId: string, token: string, window = 1): VerifyResult {
    const entry = this.getEntry(entryId);
    if (!entry) return { valid: false, counter: -1, drift: 0 };
    return verifyTotp(
      {
        secret: base32Decode(entry.secret),
        period: entry.period,
        digits: entry.digits,
        algorithm: entry.algorithm,
      },
      token.trim(),
      this.deps.now(),
      window,
    );
  }

  // ---------- 恢复码 ----------

  remainingRecovery(): number {
    return remainingRecoveryCodes(this.requireUnlocked().recoveryCodes);
  }

  /** 重新生成恢复码,旧的全部作废。 */
  async regenerateRecoveryCodes(): Promise<string[]> {
    const vault = this.requireUnlocked();
    const bundle = generateRecoveryCodes(undefined, this.deps.random);
    vault.recoveryCodes = bundle.records;
    this.audit({ action: 'recovery.generate', detail: `生成 ${bundle.plaintext.length} 个新恢复码` });
    await this.persist();
    return bundle.plaintext;
  }

  /** 使用恢复码进入。只在需要紧急访问时使用。 */
  async unlockWithRecoveryCode(code: string): Promise<boolean> {
    const raw = await this.deps.store.get(STORAGE_KEY);
    if (!raw) throw new Error('尚未创建保险库');
    // 恢复码路径同样需要主密码来解密——恢复码不持有密钥,只是绕过主密码的
    // 在线爆破成本。所以这里要求同时提供主密码,恢复码作为附加校验。
    throw new Error('请使用主密码解锁。恢复码用于在无法输入主密码时向本机重新同步保险库。');
  }

  async consumeRecovery(code: string): Promise<{ ok: boolean; reason: string }> {
    const vault = this.requireUnlocked();
    const match = verifyRecoveryCode(code, vault.recoveryCodes);
    if (!match.ok) {
      this.audit({ action: 'recovery.use', detail: '校验失败', outcome: 'denied' });
      await this.persist();
      return { ok: false, reason: match.reason };
    }
    vault.recoveryCodes = consumeRecoveryCode(vault.recoveryCodes, match.index, this.deps.now());
    this.audit({ action: 'recovery.use', detail: `第 ${match.index + 1} 个恢复码已使用` });
    await this.persist();
    return { ok: true, reason: match.reason };
  }

  // ---------- 审计 ----------

  listAudit(): AuditEvent[] {
    return [...this.requireUnlocked().auditLog];
  }

  // ---------- 同步 ----------

  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  canSync(): boolean {
    return this.deps.transport !== undefined && this.isUnlocked();
  }

  /**
   * 与云端同步。
   * 流程:拉取远端 → 尝试解密 → 合并 → 重新加密推送。
   * 若远端无法解密(通常是另一台设备用了不同主密码),
   * 直接放弃推送并报错,绝不用自己的数据覆盖远端。
   */
  async sync(): Promise<{ ok: boolean; message: string; merged: number }> {
    const transport = this.deps.transport;
    if (!transport) return { ok: false, message: '当前端未配置同步', merged: 0 };
    const vault = this.requireUnlocked();
    const password = this.requirePassword();

    try {
      const remote = await transport.pull(this.revision);
      let mergedCount = 0;

      if (remote) {
        try {
          const remotePlain = this.openVault<VaultPlain>(remote.envelope as Envelope, password);
          const result = mergeVaults(vault, remotePlain);
          this.plain = toMergeable(result.merged);
          mergedCount = result.changedEntries;
          if (mergedCount > 0) {
            this.audit({ action: 'vault.sync.merge', detail: `合并了 ${mergedCount} 项云端变更` });
          }
        } catch {
          return {
            ok: false,
            message: '云端数据无法用当前主密码解密。请确认两端使用的是同一主密码,或选择用云端数据覆盖本机。',
            merged: 0,
          };
        }
      }

      const result = await transport.push({
        envelope: this.sealVault(this.plain, password),
        updatedAt: this.deps.now(),
        deviceId: this.deps.deviceId,
        baseRevision: remote ? remote.revision : this.revision,
      });

      if (!result.ok && result.conflict) {
        // 服务端在推送期间被其他设备写入,再合并一次
        const conflictPlain = this.openVault<VaultPlain>(result.conflict.envelope as Envelope, password);
        const retry = mergeVaults(this.plain!, conflictPlain);
        this.plain = toMergeable(retry.merged);
        mergedCount += retry.changedEntries;

        const second = await transport.push({
          envelope: this.sealVault(this.plain, password),
          updatedAt: this.deps.now(),
          deviceId: this.deps.deviceId,
          baseRevision: result.conflict.revision,
        });
        if (!second.ok) {
          this.syncStatus.lastError = '同步冲突且重试失败';
          await this.storeRevision(this.revision);
          return { ok: false, message: '同步冲突,请稍后重试', merged: mergedCount };
        }
        this.revision = second.revision;
      } else if (result.ok) {
        this.revision = result.revision;
      }

      await this.persist();
      this.syncStatus.lastSyncAt = this.deps.now();
      this.syncStatus.lastError = null;
      this.syncStatus.lastMergedCount = mergedCount;
      await this.storeRevision(this.revision);
      this.audit({ action: 'vault.sync.push', detail: mergedCount > 0 ? `同步完成,合并 ${mergedCount} 项` : '同步完成' });
      await this.persist();

      return { ok: true, message: '同步完成', merged: mergedCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失败';
      this.syncStatus.lastError = message;
      await this.storeRevision(this.revision);
      return { ok: false, message, merged: 0 };
    }
  }

  // ---------- 导入导出 ----------

  /** 导出为加密文件。产出的文件即使泄露也无法在没有主密码时读取。 */
  async exportVault(): Promise<string> {
    this.requireUnlocked();
    const raw = await this.deps.store.get(STORAGE_KEY);
    if (!raw) throw new Error('尚未创建保险库');
    return raw;
  }

  /** 从加密文件导入。会覆盖当前本机数据,调用前应确认。 */
  async importVault(raw: string, password: string): Promise<void> {
    const record = JSON.parse(raw) as { envelope: Envelope; revision: number };
    // 先试解密,失败则不改动本机任何数据
    const plain = this.openVault<VaultPlain>(record.envelope, password);
    this.plain = toMergeable(plain);
    this.password = password;
    this.revision = 0;
    await this.deps.store.set(STORAGE_KEY, raw);
    await this.storeRevision(0);
    this.audit({ action: 'vault.sync.pull', detail: '从导出文件导入' });
    await this.persist();
  }

  /** 常数时间比较,给 UI 做本地校验用。 */
  static safeEqual(a: string, b: string): boolean {
    return timingSafeEqual(a, b);
  }
}

/** 供 UI 展示的说明文案,集中在一处避免各端各写一遍。 */
export const VAULT_COPY = {
  tagline: '你的第二把钥匙,只存在你自己的设备上',
  securityNote: '主密码与种子永远不会上传到服务器。忘记主密码,任何人都无法恢复你的账号。',
  syncNote: '同步的只有密文。即使服务器被入侵,攻击者拿到的也只是一堆无法解读的数据。',
} as const;
