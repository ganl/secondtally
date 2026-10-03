/**
 * 保险库数据模型。
 *
 * 明文保险库(VaultPlain)只在解锁状态下存在于内存中,
 * 任何落盘、任何上传都必须是 Envelope(密文信封)。
 * 这个区分由类型系统强制:VaultStore 的对外接口只接受和返回密文。
 */

import type { OtpEntry } from '../otpauth.js';
import type { RecoveryCodeRecord } from '../crypto/recovery.js';
import type { AuditEvent } from './audit.js';
import type { Envelope } from '../crypto/primitives.js';

/** 保险库明文结构。仅存在于内存。 */
export interface VaultPlain {
  schemaVersion: 1;
  entries: OtpEntry[];
  recoveryCodes: RecoveryCodeRecord[];
  auditLog: AuditEvent[];
  /** 上次修改时间,用于同步时的乐观并发控制。 */
  updatedAt: number;
  /** 修改设备标识,冲突时用于消解。 */
  lastDeviceId: string;
}

/** 落盘/上云的密文结构。 */
export interface VaultRecord {
  schemaVersion: 1;
  /** 加密后的保险库。 */
  envelope: Envelope;
  /** 密文的修改时间。 */
  updatedAt: number;
  deviceId: string;
  /** 单调递增版本号,服务端用它做条件写入。 */
  revision: number;
}

export function createEmptyVault(deviceId: string, now: number = Date.now()): VaultPlain {
  return {
    schemaVersion: 1,
    entries: [],
    recoveryCodes: [],
    auditLog: [],
    updatedAt: now,
    lastDeviceId: deviceId,
  };
}

export function createVaultRecord(deviceId: string, now: number = Date.now()): VaultRecord {
  return {
    schemaVersion: 1,
    envelope: {
      v: 1,
      kdf: 'pbkdf2-sha256',
      iterations: 0,
      salt: '',
      nonce: '',
      ct: '',
    },
    updatedAt: now,
    deviceId,
    revision: 0,
  };
}

/** 组合展示名,UI 各处统一使用。 */
export function displayName(entry: OtpEntry): string {
  return entry.account ? `${entry.issuer} · ${entry.account}` : entry.issuer;
}

/** 按 收藏 > 创建时间 排序,收藏优先。 */
export function sortEntries(entries: OtpEntry[]): OtpEntry[] {
  return [...entries].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
}

/** 在列表中模糊匹配 issuer 与 account。 */
export function filterEntries(entries: OtpEntry[], query: string): OtpEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return sortEntries(entries);
  return sortEntries(
    entries.filter(
      (entry) =>
        entry.issuer.toLowerCase().includes(q) ||
        entry.account.toLowerCase().includes(q) ||
        (entry.note ?? '').toLowerCase().includes(q),
    ),
  );
}
