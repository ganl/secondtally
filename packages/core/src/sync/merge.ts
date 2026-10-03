/**
 * 跨端合并:LWW-Element-Set(最后写入获胜的集合)。
 *
 * 为什么需要它:两端都可能在离线状态下改动保险库。
 * 朴素的"整份覆盖"会让后上传的一方无声吃掉另一方的修改,
 * 用户会发现自己刚在手机上加的账号在电脑上消失了——这是最糟糕的同步体验。
 *
 * 合并规则:
 * - 条目:同一 id 取 updatedAt 大者;一方删除(墓碑)且时间更新,则删除生效。
 * - 恢复码:取并集,按 index 归并,任一端标记 used 即视为已用。
 * - 审计日志:取并集,按 id 去重,按时间倒序。
 *
 * 用 墓碑(tombstone) 而非直接删数组项:否则无法区分
 * "A 端删除,B 端从未见过" 与 "B 端新增同 id",会错误地复活已删条目。
 * 由于条目 id 含时间戳前缀,复活的概率极低,但仍需保留语义正确性。
 */

import type { OtpEntry } from '../otpauth.js';
import type { RecoveryCodeRecord } from '../crypto/recovery.js';
import type { AuditEvent } from '../vault/audit.js';
import type { VaultPlain } from '../vault/model.js';

/** 带删除标记的条目。 */
export interface Tombstone {
  id: string;
  deletedAt: number;
  /** 由哪个设备删除,便于排查。 */
  deviceId: string;
}

export interface MergeableVault extends VaultPlain {
  tombstones: Tombstone[];
}

export function toMergeable(vault: VaultPlain): MergeableVault {
  return { ...vault, tombstones: [] };
}

export interface MergeResult {
  merged: MergeableVault;
  /** 本次合并实际变化的条目数,用于提示用户"已合并 N 项变更"。 */
  changedEntries: number;
  /** 是否存在真实冲突(两端都改过同一 id)。 */
  hadConflict: boolean;
}

function mergeEntries(
  local: OtpEntry[],
  remote: OtpEntry[],
  localTombstones: Tombstone[],
  remoteTombstones: Tombstone[],
): { list: OtpEntry[]; changed: number; conflict: boolean } {
  // 墓碑按 id 归并,取删除时间最晚的那条
  const tombstoneById = new Map<string, Tombstone>();
  for (const t of [...localTombstones, ...remoteTombstones]) {
    const existing = tombstoneById.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) tombstoneById.set(t.id, t);
  }

  const localIds = new Set(local.map((e) => e.id));
  const remoteIds = new Set(remote.map((e) => e.id));
  let changed = 0;
  let conflict = false;

  // 以远端为基底逐条判断,因为远端通常是"更早的快照 + 别人的修改"
  const result: OtpEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: OtpEntry) => {
    if (seen.has(entry.id)) return;
    // 墓碑时间不早于条目最后修改时间,则删除生效
    const tomb = tombstoneById.get(entry.id);
    if (tomb && tomb.deletedAt >= entry.updatedAt) return;
    seen.add(entry.id);
    result.push(entry);
  };

  for (const entry of remote) push(entry);
  for (const entry of local) {
    const inRemote = remoteIds.has(entry.id);
    if (inRemote) {
      conflict = true;
      // 两端都有同一条:取 updatedAt 大者
      const remoteEntry = remote.find((e) => e.id === entry.id)!;
      if (entry.updatedAt > remoteEntry.updatedAt) {
        // 用本地版本替换已放入的远端版本
        const idx = result.findIndex((e) => e.id === entry.id);
        if (idx !== -1) result.splice(idx, 1);
        seen.delete(entry.id);
        push(entry);
      }
    } else {
      if (!localIds.has(entry.id)) changed += 1;
      push(entry);
    }
  }

  // 同一 issuer + account 只保留一条。
  // 两端可能各自添加了同一个账号(比如同时扫了同一个服务的码),
  // 此时它们 id 不同但语义重复,若不处理用户会看到两个一模一样的条目。
  const byKey = new Map<string, OtpEntry>();
  for (const entry of result) {
    const key = `${entry.issuer.toLowerCase()}|${entry.account.toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, entry);
      continue;
    }
    if (entry.updatedAt > existing.updatedAt) byKey.set(key, entry);
  }

  const deduped = [...byKey.values()];
  // 统计相对本地的净变化
  const localKeys = new Set(local.map((e) => `${e.issuer.toLowerCase()}|${e.account.toLowerCase()}`));
  changed = deduped.filter((e) => !localKeys.has(`${e.issuer.toLowerCase()}|${e.account.toLowerCase()}`)).length;

  return { list: deduped, changed, conflict };
}

function mergeRecovery(
  local: RecoveryCodeRecord[],
  remote: RecoveryCodeRecord[],
): RecoveryCodeRecord[] {
  const byIndex = new Map<number, RecoveryCodeRecord>();
  for (const record of local) byIndex.set(record.index, record);
  for (const record of remote) {
    const existing = byIndex.get(record.index);
    if (!existing) {
      byIndex.set(record.index, record);
      continue;
    }
    // 任一端标记已用即视为已用:恢复码只能用一次,这是安全要求而非偏好
    if (existing.used || record.used) {
      byIndex.set(record.index, {
        ...existing,
        used: true,
        usedAt: existing.usedAt ?? record.usedAt,
      });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function mergeAudit(local: AuditEvent[], remote: AuditEvent[]): AuditEvent[] {
  const seen = new Set<string>();
  const out: AuditEvent[] = [];
  for (const event of [...remote, ...local]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, 500);
}

function mergeTombstones(local: Tombstone[], remote: Tombstone[]): Tombstone[] {
  const byId = new Map<string, Tombstone>();
  for (const t of [...local, ...remote]) {
    const existing = byId.get(t.id);
    if (!existing || t.deletedAt > existing.deletedAt) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/**
 * 合并本地与远端保险库。
 * 远端为空(首次同步)时直接返回本地副本。
 */
export function mergeVaults(local: VaultPlain, remote: VaultPlain): MergeResult {
  if (remote.entries.length === 0 && remote.recoveryCodes.length === 0 && remote.auditLog.length === 0) {
    return { merged: { ...local, tombstones: [] }, changedEntries: 0, hadConflict: false };
  }

  const localTombstones = 'tombstones' in local ? ((local as MergeableVault).tombstones ?? []) : [];
  const remoteTombstones = 'tombstones' in remote ? ((remote as MergeableVault).tombstones ?? []) : [];

  const { list, changed, conflict } = mergeEntries(
    local.entries,
    remote.entries,
    localTombstones,
    remoteTombstones,
  );

  return {
    merged: {
      schemaVersion: 1,
      entries: list,
      recoveryCodes: mergeRecovery(local.recoveryCodes, remote.recoveryCodes),
      auditLog: mergeAudit(local.auditLog, remote.auditLog),
      tombstones: mergeTombstones(localTombstones, remoteTombstones),
      updatedAt: Math.max(local.updatedAt, remote.updatedAt),
      lastDeviceId: remote.updatedAt > local.updatedAt ? remote.lastDeviceId : local.lastDeviceId,
    },
    changedEntries: changed,
    hadConflict: conflict,
  };
}

/** 删除条目并写入墓碑,供各端调用。 */
export function removeEntryWithTombstone(vault: MergeableVault, entryId: string, deviceId: string, now: number = Date.now()): MergeableVault {
  return {
    ...vault,
    entries: vault.entries.filter((entry) => entry.id !== entryId),
    tombstones: [...vault.tombstones, { id: entryId, deletedAt: now, deviceId }],
    updatedAt: now,
  };
}
