/**
 * Base32 (RFC 4648) 编解码。
 *
 * 之所以自己实现而不用依赖:小程序与浏览器都需要同一份实现,
 * 且各家库对填充、空白、大小写的处理并不一致,而 otpauth://
 * 里的种子在现实中常常是带空格、无填充、小写混杂的。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const DECODE_MAP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i += 1) {
    map[ALPHABET[i]!] = i;
    // 同时登记小写,解码时大小写不敏感
    map[ALPHABET[i]!.toLowerCase()] = i;
  }
  return map;
})();

/**
 * 解码 Base32 字符串为字节数组。
 * 容错处理:剥离空白、去除尾部填充、统一转大写。
 * 遇到非法字符直接抛错,而不是静默跳过——静默跳过会导致
 * 解出的种子长度错误,进而生成永远无法通过验证的验证码,
 * 这种故障极难排查,不如早失败。
 */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/\s+/g, '').replace(/=+$/g, '').toUpperCase();
  if (cleaned.length === 0) return new Uint8Array(0);

  const out = new Uint8Array(Math.floor((cleaned.length * 5) / 8));
  let bits = 0;
  let acc = 0;
  let outIndex = 0;

  for (const char of cleaned) {
    const value = DECODE_MAP[char];
    if (value === undefined) {
      throw new Error(`Base32 含有非法字符: ${char}`);
    }
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (acc >>> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

/** 编码字节数组为 Base32,默认不带填充。 */
export function base32Encode(bytes: Uint8Array, pad = false): string {
  let bits = 0;
  let acc = 0;
  let out = '';

  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(acc << (5 - bits)) & 31];
  }
  if (pad) {
    while (out.length % 8 !== 0) out += '=';
  }
  return out;
}

/** 生成适合人工输入/抄写的种子:按 4 字符分组。 */
export function base32Group(input: string, groupSize = 4): string {
  const cleaned = input.replace(/\s+/g, '');
  const parts: string[] = [];
  for (let i = 0; i < cleaned.length; i += groupSize) {
    parts.push(cleaned.slice(i, i + groupSize));
  }
  return parts.join(' ');
}
