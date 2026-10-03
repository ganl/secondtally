/**
 * otpauth:// URI 解析与生成 (Google Authenticator Key URI Format)。
 *
 * 现实中的坑:
 * - issuer 可能在 query 里,也可能只出现在 label 前缀 "Issuer:account" 中,
 *   两者不一致时以 query 的 issuer 为准(多数服务以此为准)。
 * - secret 有 Base32 空格、大小写混杂、缺少填充。
 * - algorithm/digits/period 可能缺失,必须给合理默认值。
 * - label 里的冒号分隔要从右往左拆,因为 issuer 本身可能含冒号。
 */

import { base32Encode, base32Group } from './base32.js';
import type { OtpAlgorithm } from './totp.js';
import { defaultRandom, type RandomSource } from './crypto/primitives.js';

export interface OtpEntry {
  /** 稳定唯一标识,跨端合并的键。 */
  id: string;
  /** 服务提供方,如 GitHub、Google。 */
  issuer: string;
  /** 账户标识,如 user@example.com。 */
  account: string;
  /** Base32 编码的种子。 */
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  /** 创建时间(毫秒),用于排序。 */
  createdAt: number;
  /**
   * 最后修改时间(毫秒)。
   * 跨端合并时与删除墓碑比较:若墓碑时间不早于本值,则删除生效。
   * 必须存在 updatedAt 而非只用 createdAt——条目创建后可能被改名或收藏,
   * 只看创建时间会让"删除"错误地覆盖掉删除之后的修改。
   */
  updatedAt: number;
  /** 收藏置顶。 */
  favorite?: boolean;
  /** 自由备注。 */
  note?: string;
}

export interface OtpAuthParams {
  host?: string;
  path?: string;
  type?: string;
  label?: string;
  issuer?: string;
  secret?: string;
  algorithm?: string;
  digits?: string;
  period?: string;
  counter?: string;
  [key: string]: string | undefined;
}

function parseQuery(raw: string): OtpAuthParams {
  const out: OtpAuthParams = {};
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) {
      out[decodeURIComponent(pair).toLowerCase()] = '';
      continue;
    }
    const key = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
    const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
    out[key] = value;
  }
  return out;
}

/** 规范化算法名,容忍 sha1 / SHA-1 / hmac-sha1 等写法。 */
function normalizeAlgorithm(raw: string | undefined): OtpAlgorithm {
  if (!raw) return 'SHA1';
  const upper = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper === 'SHA256') return 'SHA256';
  if (upper === 'SHA512') return 'SHA512';
  return 'SHA1';
}

/** 从 label 中拆分 issuer 与 account。 */
function splitLabel(label: string): { issuer?: string; account: string } {
  // 从右往左找冒号:account 里可能含冒号,但 issuer 通常不含
  const idx = label.indexOf(':');
  if (idx === -1) return { account: label };
  const issuer = label.slice(0, idx).trim();
  const account = label.slice(idx + 1).trim();
  return issuer ? { issuer, account } : { account };
}

let idCounter = 0;

/**
 * 生成条目 id:时间戳 + 计数器 + 随机后缀。
 *
 * 随机后缀用的是调用方注入的加密随机源而非 Math.random。
 * id 本身不承载机密,但它必须唯一:一旦两台设备离线各自添加条目时
 * 生成了相同 id,合并阶段会把它当成同一个元素,导致一个条目被另一个覆盖——
 * 这是会丢数据的。用 Math.random 在时间戳相同的毫秒内只有约1600 万种可能,
 * 且可被预测。
 */
function makeId(random: RandomSource): string {
  idCounter += 1;
  const suffix = base32Encode(random(10)).replace(/=+$/, '').toLowerCase();
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${suffix}`;
}

/**
 * 解析 otpauth:// URI。
 * @throws 当缺少 secret 时抛出——没有种子的条目毫无意义,应让用户明确知道扫码失败。
 */
export function parseOtpAuthUri(
  uri: string,
  now: number = Date.now(),
  random: RandomSource = defaultRandom,
): OtpEntry {
  const trimmed = uri.trim();
  if (!/^otpauth:\/\//i.test(trimmed)) {
    throw new Error('不是有效的 otpauth:// 链接');
  }

  const withoutScheme = trimmed.slice('otpauth://'.length);
  const qIndex = withoutScheme.indexOf('?');
  const beforeQuery = qIndex === -1 ? withoutScheme : withoutScheme.slice(0, qIndex);
  const query = qIndex === -1 ? '' : withoutScheme.slice(qIndex + 1);

  const slashIndex = beforeQuery.indexOf('/');
  const type = (slashIndex === -1 ? beforeQuery : beforeQuery.slice(0, slashIndex)).toLowerCase();
  const label = slashIndex === -1 ? '' : beforeQuery.slice(slashIndex + 1);

  if (type !== 'totp' && type !== 'hotp') {
    throw new Error(`暂不支持的类型: ${type || '(空)'}`);
  }

  const params = parseQuery(query);
  const secret = (params.secret ?? '').replace(/\s+/g, '');
  if (!secret) {
    throw new Error('链接中缺少 secret 字段');
  }

  const fromLabel = splitLabel(decodeURIComponent(label));
  const issuer = (params.issuer ?? fromLabel.issuer ?? '').trim();
  const account = (fromLabel.account ?? '').trim();

  const digitsRaw = Number.parseInt(params.digits ?? '', 10);
  const periodRaw = Number.parseInt(params.period ?? '', 10);

  return {
    id: makeId(random),
    issuer: issuer || '未知服务',
    account: account || '未命名账户',
    secret: secret.toUpperCase(),
    algorithm: normalizeAlgorithm(params.algorithm),
    digits: Number.isFinite(digitsRaw) && digitsRaw > 0 ? digitsRaw : 6,
    period: Number.isFinite(periodRaw) && periodRaw > 0 ? periodRaw : 30,
    createdAt: now,
    updatedAt: now,
  };
}

/** 判断字符串是否为可解析的 otpauth 链接。 */
export function isOtpAuthUri(value: string): boolean {
  return /^otpauth:\/\//i.test(value.trim());
}

/** 生成 otpauth:// URI,用于导出与跨端迁移。 */
export function buildOtpAuthUri(entry: OtpEntry): string {
  const label = `${encodeURIComponent(entry.issuer)}:${encodeURIComponent(entry.account)}`;
  const params = [
    `secret=${encodeURIComponent(entry.secret)}`,
    `issuer=${encodeURIComponent(entry.issuer)}`,
    `algorithm=${entry.algorithm}`,
    `digits=${entry.digits}`,
    `period=${entry.period}`,
  ];
  return `otpauth://totp/${label}?${params.join('&')}`;
}

/** 给人看的种子展示形式,分组便于核对。 */
export function formatSecret(secret: string): string {
  return base32Group(base32Encode(new Uint8Array(0)) + secret.toUpperCase().replace(/=+$/, ''));
}

/** 估算剩余有效秒数,供 UI 做倒计时。 */
export function remainingSeconds(period: number, nowMs: number = Date.now()): number {
  const periodMs = period * 1000;
  return Math.max(0, Math.ceil((periodMs - (nowMs % periodMs)) / 1000));
}
