/**
 * 恢复码(备用码)生成与校验。
 *
 * 设计要点:
 * - 恢复码本身是长期凭据,因此只存哈希,不存明文。丢了就丢了,这是有意的取舍:
 *   能离线校验的明文恢复码,一旦库被脱库就等于把所有账号一次性交出。
 * - 存储时用逐条加盐哈希(而非整体一次哈希),这样校验单条时不会泄露总条数以外的信息,
 *   且删掉一条不影响其余条目的校验。
 * - 格式使用无歧义字符集,剔除 0/O/1/I/L,避免用户抄写时出错。
 */

import { sha256 } from '@noble/hashes/sha256.js';
import { hex, utf8 } from './primitives.js';
import { timingSafeEqual, type RandomSource, defaultRandom } from './primitives.js';

/** 去除易混淆字符:0 O 1 I L。 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_GROUPS = 2;
const RECOVERY_GROUP_LEN = 5;

export interface RecoveryCodeRecord {
  /** 位置序号,用于展示"第 3/10 个"。 */
  index: number;
  /** 该码的哈希(hex),不含盐——盐单独存在 hashes 中。 */
  hash: string;
  /** 该码专属盐(hex),保证同码不同条也有不同哈希。 */
  salt: string;
  /** 是否已使用。用过的码必须失效,否则等于没设置恢复码。 */
  used: boolean;
  /** 使用时间(毫秒),未使用为 null。 */
  usedAt: number | null;
}

function randomChars(length: number, random: RandomSource): string {
  const bytes = random(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

function hashCode(code: string, saltHex: string): string {
  const salted = `${saltHex}:${code.replace(/[\s-]/g, '').toUpperCase()}`;
  return hex.encode(sha256(utf8.encode(salted)));
}

export interface RecoveryCodeBundle {
  /** 明文码,仅在生成的那一刻返回一次,用于展示给用户抄写。 */
  plaintext: string[];
  records: RecoveryCodeRecord[];
}

/** 生成一组恢复码。 */
export function generateRecoveryCodes(
  count: number = RECOVERY_CODE_COUNT,
  random: RandomSource = defaultRandom,
): RecoveryCodeBundle {
  const plaintext: string[] = [];
  const records: RecoveryCodeRecord[] = [];

  for (let i = 0; i < count; i += 1) {
    const body = randomChars(RECOVERY_CODE_GROUPS * RECOVERY_GROUP_LEN, random);
    const groups: string[] = [];
    for (let g = 0; g < RECOVERY_CODE_GROUPS; g += 1) {
      groups.push(body.slice(g * RECOVERY_GROUP_LEN, (g + 1) * RECOVERY_GROUP_LEN));
    }
    const code = groups.join('-');
    const saltHex = hex.encode(random(16));
    plaintext.push(code);
    records.push({
      index: i,
      hash: hashCode(code, saltHex),
      salt: saltHex,
      used: false,
      usedAt: null,
    });
  }

  return { plaintext, records };
}

/** 规范化用户输入:去空格转大写。 */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s_]/g, '-').toUpperCase();
}

export interface RecoveryMatch {
  ok: boolean;
  /** 命中的记录下标,用于标记为已使用。 */
  index: number;
  reason: string;
}

/** 校验一个恢复码。 */
export function verifyRecoveryCode(code: string, records: RecoveryCodeRecord[]): RecoveryMatch {
  const normalized = normalizeRecoveryCode(code);
  for (const record of records) {
    const candidate = hashCode(normalized, record.salt);
    if (timingSafeEqual(candidate, record.hash)) {
      if (record.used) {
        return { ok: false, index: record.index, reason: '该恢复码已被使用过' };
      }
      return { ok: true, index: record.index, reason: '恢复码有效' };
    }
  }
  return { ok: false, index: -1, reason: '恢复码无效' };
}

/** 标记某个恢复码为已使用。返回新数组,便于放入不可变状态。 */
export function consumeRecoveryCode(records: RecoveryCodeRecord[], index: number, now: number = Date.now()): RecoveryCodeRecord[] {
  return records.map((record) =>
    record.index === index ? { ...record, used: true, usedAt: now } : record,
  );
}

/** 统计剩余可用恢复码数量,低于 3 时应提示用户补充。 */
export function remainingRecoveryCodes(records: RecoveryCodeRecord[]): number {
  return records.filter((record) => !record.used).length;
}
