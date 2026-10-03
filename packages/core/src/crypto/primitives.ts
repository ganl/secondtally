/**
 * 密钥派生与对称加密。
 *
 * 为什么全用 @noble 而不用 WebCrypto:
 * 微信小程序不提供 crypto.subtle,Web Crypto 在小程序里不可用。
 * @noble 是纯 JS 实现,经过审计,在小程序与浏览器中行为一致。
 *
 * 威胁模型:
 * 假设攻击者拿到了设备存储与同步服务器上的全部数据(设备丢失 + 后台被脱库同时发生),
 * 攻击者仍无法在没有主密码的情况下解出任何种子。这是本项目安全性的下限。
 */

import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha256.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * PBKDF2 迭代次数。
 *
 * OWASP 2023 对 PBKDF2-HMAC-SHA256 的现行推荐是 600,000。这里取 210,000:
 * - 实测纯 JS 实现在桌面端约 450ms/次,低端安卓机会到 1.5-2s,
 *   600,000 会让开屏体验明显变差;
 * - 迭代次数随密文一起存储(见 Envelope.iterations),日后上调只需
 *   在下次写入时生效,旧数据仍能用旧参数解开,不存在迁移风险。
 */
export const PBKDF2_ITERATIONS = 210_000;

/**
 * 迭代次数下限。
 * 低于这个值的信封一律拒绝打开,防止攻击者(或误操作)把迭代降到个位数
 * 后重新加密,让整个保险库变成可被秒破的弱加密。
 * 测试环境通过 createVaultWithKdf 显式豁免。
 */
export const MIN_KDF_ITERATIONS = 100_000;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

/** 字节与 hex/base64 的互转,避免在调用点散落手写循环。 */
export const hex = {
  encode: bytesToHex,
  decode: hexToBytes,
};

export const utf8 = {
  encode: utf8ToBytes,
  decode: (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes),
};

/**
 * 生成密码学安全随机字节。
 * 小程序提供 wx.getRandomValues,但该 API 在极旧基础库上缺失,
 * 因此由调用方注入一个可信来源,避免这里出现平台判断。
 */
export type RandomSource = (length: number) => Uint8Array;

/** 默认随机源:优先使用 WebCrypto,不可用时回退到 @noble 内部实现。 */
export const defaultRandom: RandomSource = (length: number) => {
  const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
  if (typeof g.crypto?.getRandomValues === 'function') {
    return g.crypto.getRandomValues(new Uint8Array(length));
  }
  return nobleRandomBytes(length);
};

/** 主密码 → 加密密钥。盐必须随密文一起存储,否则无法复现。 */
export function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS,
): Uint8Array {
  if (password.length === 0) {
    throw new Error('主密码不能为空');
  }
  return pbkdf2(sha256, password.normalize('NFKC'), salt, { c: iterations, dkLen: KEY_BYTES });
}

/** 生成新盐。 */
export function generateSalt(random: RandomSource = defaultRandom): Uint8Array {
  return random(SALT_BYTES);
}

export interface Envelope {
  /** 信封格式版本,用于未来算法升级时的向前兼容。 */
  v: 1;
  /** KDF 标识,便于日后换 Argon2 时平滑迁移。 */
  kdf: 'pbkdf2-sha256';
  /** 迭代次数,必须随密文存储,否则调参后旧数据无法解开。 */
  iterations: number;
  /** hex 编码的盐。 */
  salt: string;
  /** hex 编码的 GCM nonce。 */
  nonce: string;
  /** hex 编码的密文(含 16 字节 tag)。 */
  ct: string;
}

/**
 * AES-256-GCM 加密。
 *
 * GCM 的 nonce 绝不能重复——同密钥下 nonce 重复会直接摧毁 GCM 的安全性,
 * 甚至可在特定条件下恢复出密钥的异或流。这里用 96-bit 随机 nonce,
 * 在单用户可产生的加密次数(即使每天同步一次也需 2^32 年才可能碰撞)下是安全的。
 * 更严格的方案是每条记录用独立数据密钥,当前规模尚不需要。
 */
export function seal(
  plaintext: Uint8Array,
  key: Uint8Array,
  salt: Uint8Array,
  random: RandomSource = defaultRandom,
  iterations: number = PBKDF2_ITERATIONS,
): Envelope {
  const nonce = random(NONCE_BYTES);
  const cipher = gcm(key, nonce);
  const ct = cipher.encrypt(plaintext);
  return {
    v: 1,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: hex.encode(salt),
    nonce: hex.encode(nonce),
    ct: hex.encode(ct),
  };
}

/**
 * 解密。GCM 校验失败会抛错,这正是我们想要的:
 * 它把"密码错误"和"密文被篡改"都归为解密失败,不向外泄露区分信息。
 */
export function open(envelope: Envelope, password: string, allowWeakKdf = false): Uint8Array {
  if (envelope.v !== 1) {
    throw new Error(`不支持的信封版本: ${envelope.v}`);
  }
  if (envelope.kdf !== 'pbkdf2-sha256') {
    throw new Error(`不支持的 KDF: ${envelope.kdf}`);
  }
  // 拒绝打开迭代次数异常低的信封。若不校验,攻击者拿到库后可以构造一个
  // 迭代为 1 的信封让用户导入,把用户的全部种子降级成可秒破的弱加密。
  if (!allowWeakKdf && envelope.iterations < MIN_KDF_ITERATIONS) {
    throw new Error(
      `数据使用的密钥派生强度过低(${envelope.iterations} 次),已拒绝加载。请检查数据来源是否可信。`,
    );
  }
  const key = deriveKey(password, hex.decode(envelope.salt), envelope.iterations);
  const nonce = hex.decode(envelope.nonce);
  const ct = hex.decode(envelope.ct);
  const cipher = gcm(key, nonce);
  try {
    return cipher.decrypt(ct);
  } catch {
    throw new Error('解密失败:主密码错误或数据已损坏');
  }
}

/** 便捷封装:加密任意可 JSON 序列化的值。 */
export function sealJson(
  value: unknown,
  password: string,
  random: RandomSource = defaultRandom,
  iterations: number = PBKDF2_ITERATIONS,
): Envelope {
  const salt = generateSalt(random);
  const key = deriveKey(password, salt, iterations);
  return seal(utf8.encode(JSON.stringify(value)), key, salt, random, iterations);
}

/** 便捷封装:解密 JSON 值。 */
export function openJson<T>(envelope: Envelope, password: string, allowWeakKdf = false): T {
  return JSON.parse(utf8.decode(open(envelope, password, allowWeakKdf))) as T;
}

/**
 * 常数时间比较,用于校验恢复码等敏感值。
 * 普通字符串比较会因短路而在首个不同字符处返回,时间差可被用来逐位爆破。
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 密码强度评估。用于给用户即时反馈,避免弱主密码让整个加密体系形同虚设。
 * 评估在端上完成,不外传。
 */
export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  hint: string;
}

export function assessPassword(password: string): PasswordStrength {
  if (password.length < 8) {
    return { score: 0, label: '太弱', hint: '主密码至少需要 8 个字符' };
  }
  let score = 1;
  if (password.length >= 12) score += 1;
  if (password.length >= 16) score += 1;

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes >= 3) score += 1;
  if (classes === 4 && password.length >= 12) score += 1;

  const clamped = Math.min(4, score) as 0 | 1 | 2 | 3 | 4;
  const labels = ['太弱', '偏弱', '一般', '较强', '很强'];
  const hints = [
    '主密码至少需要 8 个字符',
    '建议加入大写字母、数字或符号',
    '建议至少 12 位并混合多类字符',
    '再长一些或用一句易记的短语会更稳',
    '这是一个强度不错的主密码',
  ];
  return { score: clamped, label: labels[clamped]!, hint: hints[clamped]! };
}
