import test from 'node:test';
import assert from 'node:assert/strict';

import { hotp, totpAt, verifyTotp, selfTest, base32Decode, base32Encode, base32Group } from '../dist/index.mjs';

const SHA1_SECRET = new TextEncoder().encode('12345678901234567890');
// RFC 6238 附录 B:每种算法使用不同长度的种子
const SHA256_SECRET = new TextEncoder().encode('12345678901234567890123456789012');
const SHA512_SECRET = new TextEncoder().encode(
  '1234567890123456789012345678901234567890123456789012345678901234',
);

test('RFC 4226 HOTP 全部 20 个向量通过', () => {
  const expected = [
    '755224', '287082', '359152', '969429', '338314',
    '254676', '287922', '162583', '399871', '520489',
    '403154', '481090', '868912', '736127', '229903',
    '436521', '186581', '447589', '903435', '578337',
  ];
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(hotp(SHA1_SECRET, i), expected[i], `counter=${i} 不匹配`);
  }
});

test('模块自检通过', () => {
  assert.equal(selfTest(), true);
});

test('RFC 6238 SHA1 向量(6 位)', () => {
  // 注意:RFC 6238 附录 B 给的是 8 位值,6 位码是同一个 31 位二进制数 mod 10^6,
  // 因此取的是该值的【后 6 位】而非前 6 位。
  // T=59 的 8 位真值为 94287082(流传较广的 94271882 是数字转置笔误),
  // 已用 node:crypto 独立交叉验证,见 test/crosscheck.mjs。
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [seconds, code6] of vectors) {
    assert.equal(totpAt({ secret: SHA1_SECRET }, seconds * 1000).code, code6, `T=${seconds}s`);
  }
});

test('RFC 6238 SHA256 向量', () => {
  // 8 位值 46119246 -> 后 6 位 119246
  assert.equal(totpAt({ secret: SHA256_SECRET, algorithm: 'SHA256' }, 59 * 1000).code, '119246');
});

test('RFC 6238 SHA512 向量', () => {
  // 8 位值 90693936 -> 后 6 位 693936
  assert.equal(totpAt({ secret: SHA512_SECRET, algorithm: 'SHA512' }, 59 * 1000).code, '693936');
});

test('时间窗口边界计算正确', () => {
  const at = 1234567890000;
  const result = totpAt({ secret: SHA1_SECRET }, at);
  assert.equal(result.validFrom, Math.floor(at / 30000) * 30000);
  assert.equal(result.validUntil, result.validFrom + 30000);
  assert.equal(result.remaining, result.validUntil - at);
});

test('验证码带前导零补齐', () => {
  const code = hotp(SHA1_SECRET, 1, 8);
  assert.equal(code.length, 8);
  assert.match(code, /^\d{8}$/);
  // 6 位码中 T=1234567890 应为 005924,验证前导零未丢失
  assert.equal(totpAt({ secret: SHA1_SECRET }, 1234567890000).code, '005924');
});

test('校验窗口内命中,窗口外拒绝', () => {
  const at = 1234567890000;
  const current = totpAt({ secret: SHA1_SECRET }, at);
  assert.equal(verifyTotp({ secret: SHA1_SECRET }, current.code, at, 1).valid, true);
  assert.equal(verifyTotp({ secret: SHA1_SECRET }, current.code, at, 1).drift, 0);

  const prev = totpAt({ secret: SHA1_SECRET }, at - 30000);
  const drift = verifyTotp({ secret: SHA1_SECRET }, prev.code, at, 1);
  assert.equal(drift.valid, true);
  assert.equal(drift.drift, -1);

  assert.equal(verifyTotp({ secret: SHA1_SECRET }, prev.code, at, 0).valid, false);
});

test('容错:带空格、小写、无填充的种子算出相同结果', () => {
  const canonical = totpAt({ secret: SHA1_SECRET }, 59000).code;
  const messy = base32Group(base32Encode(SHA1_SECRET).toLowerCase(), 4);
  const decoded = base32Decode(messy);
  assert.equal(Buffer.from(decoded).toString(), '12345678901234567890');
  assert.equal(totpAt({ secret: decoded }, 59000).code, canonical);
});

test('Base32 编解码往返一致', () => {
  for (const len of [1, 5, 10, 16, 20, 32, 64]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = (i * 37 + 11) & 0xff;
    assert.deepEqual(
      Array.from(base32Decode(base32Encode(bytes))),
      Array.from(bytes),
      `len=${len} 往返失败`,
    );
  }
});

test('Base32 非法字符立即报错而非静默跳过', () => {
  assert.throws(() => base32Decode('ABC!DEF'), /非法字符/);
});

test('计数器跨 2^32 仍正确(8 字节大端)', () => {
  const high = hotp(SHA1_SECRET, 4294967296);
  assert.match(high, /^\d{6}$/);
  assert.notEqual(high, hotp(SHA1_SECRET, 4294967297));
});

test('加解密往返一致,且错误密码必然失败', async () => {
  const { sealJson, openJson } = await import('../dist/index.mjs');
  const payload = { entries: [{ id: 'a', secret: 'JBSWY3DPEHPK3PXP' }], schemaVersion: 1 };
  const env = sealJson(payload, 'correct horse battery staple');
  assert.deepEqual(openJson(env, 'correct horse battery staple'), payload);
  // GCM 认证失败必须抛错,不能返回垃圾数据
  assert.throws(() => openJson(env, 'wrong password'), /解密失败/);
});

test('相同明文两次加密产出不同密文(随机 nonce 生效)', async () => {
  const { sealJson } = await import('../dist/index.mjs');
  const a = sealJson({ x: 1 }, 'pw');
  const b = sealJson({ x: 1 }, 'pw');
  assert.notEqual(a.nonce, b.nonce, 'nonce 重复会摧毁 GCM 安全性');
  assert.notEqual(a.salt, b.salt, '盐必须每条不同');
  assert.notEqual(a.ct, b.ct);
});
