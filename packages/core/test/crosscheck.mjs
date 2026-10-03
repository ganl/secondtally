/**
 * 用 Node 原生 crypto(HMAC-SHA1)作为独立实现,交叉验证 @noble 实现。
 *
 * 为什么要"两个实现互验":如果只用 RFC 向量,一旦我把向量抄错,
 * 会误判成实现有 bug 并去改正确的代码。两套独立实现一致,
 * 才能确定是期望值错还是实现错。
 */
import { createHmac } from 'node:crypto';
import { totpAt, hotp, selfTest } from '../dist/index.mjs';

// ---- 独立的参考实现,直接用 node:crypto ----
function refHOTP(secret, counter, digits = 6, algo = 'sha1') {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algo, Buffer.from(secret)).update(buf).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin =
    ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

const secret = '12345678901234567890';
let mismatch = 0;
console.log('counter | 我的实现 | node:crypto | 一致');
for (let i = 0; i < 20; i += 1) {
  const mine = hotp(Buffer.from(secret), i);
  const ref = refHOTP(secret, i);
  const ok = mine === ref;
  if (!ok) mismatch += 1;
  console.log(`  ${String(i).padStart(2)}    | ${mine}  |    ${ref}    | ${ok ? 'OK' : 'MISMATCH'}`);
}
console.log(`\n不一致数量: ${mismatch}`);

console.log('\n--- 8 位 RFC 6238 向量与 6 位取模关系 ---');
console.log('关键: 8 位码 mod 10^6 取的是【后 6 位】,不是前 6 位');
const rfc8 = [
  [59, '94271882', 'sha1'],
  [1111111109, '07081804', 'sha1'],
  [1111111111, '14050471', 'sha1'],
  [1234567890, '89005924', 'sha1'],
  [2000000000, '69279037', 'sha1'],
  [20000000000, '65353130', 'sha1'],
  [59, '46119246', 'sha256'],
  [59, '90693936', 'sha512'],
];
for (const [t, code8, algo] of rfc8) {
  const mine6 = totpAt({ secret: Buffer.from(secret), algorithm: algo.toUpperCase() }, t * 1000).code;
  const last6 = code8.slice(-6);
  const counter = Math.floor(t / 30);
  const ref6 = refHOTP(secret, counter, 6, algo);
  console.log(
    `T=${String(t).padEnd(11)} ${algo.padEnd(6)} RFC8位=${code8} 后6位=${last6} 我的=${mine6} 参考=${ref6} ${mine6 === last6 && mine6 === ref6 ? 'OK' : 'CHECK'}`,
  );
}

console.log('\nselfTest():', selfTest());
