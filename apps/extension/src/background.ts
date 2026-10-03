/**
 * 扩展后台 service worker。
 *
 * 为什么必须用 service worker 而不是页面脚本:
 * MV3 的 service worker 会在空闲约 30 秒后被浏览器杀掉。
 * 这对本应用是特性而非缺陷——保险库密钥只在内存中,
 * worker 一旦被杀,所有解密后的种子随内存一起消失,
 * 用户下次打开必须重新输入主密码。这正是我们想要的行为。
 *
 * 但也带来一个约束:每次弹窗打开时,worker 可能刚刚被重启,
 * 所以状态必须能从 chrome.storage 恢复,不能假设内存还在。
 *
 * 关键安全决策:
 * 1. 主密码不保存在任何持久化存储中,每次会话由用户重新输入。
 * 2. 锁定后立刻丢弃内存中的密钥引用。
 * 3. 响应填充请求时只返回验证码字符串,绝不移除种子。
 * 4. 锁定状态下对任何请求都拒绝响应,不做"静默失败"。
 */

import { VaultService, type RandomSource } from '@aegis/core';
import { createExtensionPlatform } from './platform.js';

const LOCK_AFTER_MS = 5 * 60 * 1000;
const STORAGE_PREFIX = 'aegis.ext.v1.';

declare const chrome: {
  storage: {
    local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  runtime: {
    onMessage: {
      addListener(
        cb: (msg: unknown, sender: unknown, respond: (r: unknown) => void) => boolean | void,
      ): void;
    };
    onInstalled: { addListener(cb: () => void): void };
    getURL(path: string): string;
  };
};

/** 只存在于内存的会话状态。worker 被杀即失效,这是预期行为。 */
interface Session {
  vault: VaultService;
  unlockAt: number;
}

let session: Session | null = null;
let initPromise: Promise<VaultService> | null = null;

async function ensureDeviceId(): Promise<string> {
  const bag = await chrome.storage.local.get(STORAGE_PREFIX + 'deviceId');
  const existing = bag[STORAGE_PREFIX + 'deviceId'];
  if (typeof existing === 'string' && existing.length > 0) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await chrome.storage.local.set({ [STORAGE_PREFIX + 'deviceId']: id });
  return id;
}

async function getVault(): Promise<VaultService> {
  if (!initPromise) {
    initPromise = (async () => {
      const platform = createExtensionPlatform();
      const deviceId = await ensureDeviceId();
      const random: RandomSource = (n: number) => platform.random.bytes(n);
      const vault = new VaultService({
        store: platform.store,
        deviceId,
        deviceName: '浏览器扩展',
        now: () => Date.now(),
        random,
        lockAfterMs: LOCK_AFTER_MS,
      });
      await vault.init();
      return vault;
    })();
  }
  return initPromise;
}

/** 取当前可用的保险库;若已锁定或超时则返回 null。 */
async function activeVault(): Promise<VaultService | null> {
  if (session && Date.now() - session.unlockAt > LOCK_AFTER_MS) {
    await lockNow();
    return null;
  }
  if (!session) return null;
  return session.vault;
}

async function lockNow(): Promise<void> {
  if (session) {
    // lock() 会清空内存中的密钥并把密文落盘
    await session.vault.lock();
  }
  session = null;
}

type Request =
  | { type: 'aegis:hasVault' }
  | { type: 'aegis:isUnlocked' }
  | { type: 'aegis:create'; password: string; confirm: string }
  | { type: 'aegis:unlock'; password: string }
  | { type: 'aegis:lock' }
  | { type: 'aegis:list' }
  | { type: 'aegis:addManual'; issuer: string; account: string; secret: string; digits?: number; period?: number; algorithm?: string }
  | { type: 'aegis:remove'; id: string }
  | { type: 'aegis:codeFor'; host: string }
  | { type: 'aegis:fillAll' };

async function handle(request: Request): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const vault = await getVault();

  switch (request.type) {
    case 'aegis:hasVault':
      return { ok: true, data: await vault.hasVault() };

    case 'aegis:isUnlocked':
      return { ok: true, data: (await activeVault()) !== null };

    case 'aegis:create': {
      const codes = await vault.create(request.password, request.confirm);
      session = { vault, unlockAt: Date.now() };
      // 恢复码只在此刻返回一次,弹窗负责展示;之后无法再取回
      return { ok: true, data: { recoveryCodes: codes } };
    }

    case 'aegis:unlock': {
      await vault.unlock(request.password);
      session = { vault, unlockAt: Date.now() };
      return { ok: true };
    }

    case 'aegis:lock':
      await lockNow();
      return { ok: true };

    case 'aegis:list': {
      const active = await activeVault();
      if (!active) return { ok: false, error: 'locked' };
      const codes = active.generateAllCodes();
      return {
        ok: true,
        data: codes.map(({ entry, code }) => ({
          id: entry.id,
          issuer: entry.issuer,
          account: entry.account,
          code: code.code,
          remaining: code.remaining,
        })),
      };
    }

    case 'aegis:addManual': {
      const active = await activeVault();
      if (!active) return { ok: false, error: 'locked' };
      const entry = await active.addManual({
        issuer: request.issuer,
        account: request.account,
        secret: request.secret,
        digits: request.digits ?? 6,
        period: request.period ?? 30,
        algorithm: (request.algorithm as 'SHA1') ?? 'SHA1',
      });
      return { ok: true, data: { id: entry.id } };
    }

    case 'aegis:remove': {
      const active = await activeVault();
      if (!active) return { ok: false, error: 'locked' };
      await active.removeEntry(request.id);
      return { ok: true };
    }

    case 'aegis:codeFor': {
      const active = await activeVault();
      if (!active) return { ok: false, error: 'locked' };
      // 按域名匹配:取最长后缀匹配,避免 example.com 命中 aexample.com
      const host = request.host.toLowerCase();
      let best: { id: string; issuer: string; account: string; code: string; remaining: number } | null = null;
      for (const { entry, code } of active.generateAllCodes()) {
        const issuerHost = entry.issuer.toLowerCase().replace(/[^a-z0-9.]/g, '');
        const isMatch =
          issuerHost !== '' && (host === issuerHost || host.endsWith(`.${issuerHost}`));
        if (isMatch) {
          // 多个条目都匹配时,取 issuer 字符串最长的(最具体)那个
          if (!best || issuerHost.length > best.issuer.toLowerCase().replace(/[^a-z0-9.]/g, '').length) {
            best = { id: entry.id, issuer: entry.issuer, account: entry.account, code: code.code, remaining: code.remaining };
          }
        }
      }
      return { ok: true, data: best };
    }

    case 'aegis:fillAll': {
      const active = await activeVault();
      if (!active) return { ok: false, error: 'locked' };
      return {
        ok: true,
        data: active.generateAllCodes().map(({ entry, code }) => ({
          id: entry.id,
          issuer: entry.issuer,
          account: entry.account,
          code: code.code,
          remaining: code.remaining,
        })),
      };
    }

    default:
      return { ok: false, error: 'unknown request' };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  handle(msg as Request).then(respond, (error: unknown) => {
    respond({ ok: false, error: error instanceof Error ? error.message : 'unknown error' });
  });
  return true; // 保持消息通道以支持异步响应
});
