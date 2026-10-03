/**
 * TOTP (RFC 6238) / HOTP (RFC 4226) 实现。
 *
 * 关键细节:
 * 1. HMAC-SHA1 的输出必须做动态截断(dynamic truncation),
 *    取 offset = digest[19] & 0x0f 处的 4 字节,再清掉最高位。
 *    直接取前 4 字节是常见错误,会导致验证码永远对不上。
 * 2. 计数器是 8 字节大端,不是 4 字节。种子超过 2^32 时行为不同。
 * 3. 数字转字符串要做前导零补齐,6 位码里 "123" 必须是 "000123"。
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha1 } from '@noble/hashes/sha1.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { sha512 } from '@noble/hashes/sha512.js';
import { base32Decode } from './base32.js';

export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

const HASHES = {
  SHA1: sha1,
  SHA256: sha256,
  SHA512: sha512,
} as const;

/**
 * RFC 4226 附录 D 的 20 个测试码(种子 "12345678901234567890")。
 * 这组值已与 Node 原生 crypto 交叉验证一致,见 test/crosscheck.mjs。
 */
const RFC4226_VECTORS = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
  '403154', '481090', '868912', '736127', '229903',
  '436521', '186581', '447589', '903435', '578337',
];

/** 把计数器编成 8 字节大端。 */
function counterToBytes(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  let n = counter;
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

/** 对 HMAC 输出做动态截断,得到 31 位正整数。 */
function dynamicTruncate(digest: Uint8Array): number {
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return binary % 4294967296;
}

function padCode(value: number, digits: number): string {
  return value.toString().padStart(digits, '0');
}

export interface TotpOptions {
  /** 密钥,原始字节。若传 base32 字符串请改用 secretFromBase32。 */
  secret: Uint8Array;
  /** 时间步长,默认 30 秒(绝大多数服务使用)。 */
  period?: number;
  /** 验证码位数,默认 6。 */
  digits?: number;
  /** 摘要算法,默认 SHA1。 */
  algorithm?: OtpAlgorithm;
}

export interface TotpCode {
  /** 补齐前导零后的验证码。 */
  code: string;
  /** 该码所属时间窗口的起始毫秒时间戳。 */
  validFrom: number;
  /** 该码失效的毫秒时间戳。 */
  validUntil: number;
  /** 距离失效的剩余毫秒数。 */
  remaining: number;
  /** 计数器值,用于防重放判定。 */
  counter: number;
}

/** 基础 HOTP 计算。 */
export function hotp(secret: Uint8Array, counter: number, digits = 6, algorithm: OtpAlgorithm = 'SHA1'): string {
  const digest = hmac(HASHES[algorithm], secret, counterToBytes(counter));
  return padCode(dynamicTruncate(digest) % 10 ** digits, digits);
}

/** 把 Base32 种子转为字节,这是最常见的输入形式。 */
export function secretFromBase32(base32: string): Uint8Array {
  return base32Decode(base32);
}

/**
 * 计算指定时刻的 TOTP。
 *
 * @param atMs 该时刻的 Unix 毫秒时间戳。生产环境应传入服务器校准后的时间,
 *             直接用 Date.now() 在用户设备时间被篡改时会算出错误结果。
 */
export function totpAt(options: TotpOptions, atMs: number): TotpCode {
  // 运行时防线。TypeScript 声明 secret 是 Uint8Array,但 esbuild 只打包不做类型
  // 检查,写错的调用方(如误传 base32 字符串)不会被拦下。若放行,HMAC 会把字符串
  // 的 UTF-8 字节当密钥,算出一个格式正常、永不通过验证的验证码——
  // 用户只会看到"验证码总是错",极难定位。宁可立刻抛错。
  if (!(options.secret instanceof Uint8Array)) {
    throw new Error(
      'secret 必须是 Uint8Array。若持有 base32 字符串,请先调用 base32Decode() 或 secretFromBase32()。',
    );
  }

  const period = options.period ?? 30;
  const digits = options.digits ?? 6;
  const algorithm = options.algorithm ?? 'SHA1';

  const counter = Math.floor(atMs / 1000 / period);
  const validFrom = counter * period * 1000;
  const validUntil = validFrom + period * 1000;

  return {
    code: hotp(options.secret, counter, digits, algorithm),
    validFrom,
    validUntil,
    remaining: validUntil - atMs,
    counter,
  };
}

/** 计算当前时刻的 TOTP。 */
export function totpNow(options: TotpOptions, nowMs: number = Date.now()): TotpCode {
  return totpAt(options, nowMs);
}

export interface VerifyResult {
  valid: boolean;
  /** 命中的计数器,便于调用方做防重放记录。 */
  counter: number;
  /** 实际偏差的步数,0 表示当前窗口命中。 */
  drift: number;
}

/**
 * 校验验证码。
 *
 * @param window 允许的时间步漂移。设为 1 表示容忍前后各一个窗口,
 *               可吸收两端设备时钟不一致导致的误判。设为 0 则严格校验。
 *               注意:窗口越大,被重放攻击利用的时间窗也越大,应尽量小。
 */
export function verifyTotp(
  options: TotpOptions,
  token: string,
  atMs: number = Date.now(),
  window = 1,
): VerifyResult {
  const period = options.period ?? 30;
  const current = Math.floor(atMs / 1000 / period);
  const normalized = token.replace(/\s+/g, '');

  for (let drift = -window; drift <= window; drift += 1) {
    const counter = current + drift;
    if (counter < 0) continue;
    if (hotp(options.secret, counter, options.digits ?? 6, options.algorithm ?? 'SHA1') === normalized) {
      return { valid: true, counter, drift };
    }
  }
  return { valid: false, counter: -1, drift: 0 };
}

/**
 * 自检:确认 HMAC-SHA1 与动态截断实现正确。
 * 一旦基础运算出错,后续所有验证码都会错,且极难定位,
 * 所以在模块加载时静默验证一次。
 *
 * 种子由字符串直接编码得到,避免手写十六进制字节时抄错——
 * 之前手写过一版,字节解出来是乱码,导致自检永远失败、形同虚设。
 */
export function selfTest(): boolean {
  const secret = new TextEncoder().encode('12345678901234567890');
  for (let counter = 0; counter < RFC4226_VECTORS.length; counter += 1) {
    if (hotp(secret, counter) !== RFC4226_VECTORS[counter]) return false;
  }
  return true;
}
