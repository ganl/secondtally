/**
 * Google Authenticator 批量导出协议解析。
 *
 * 原理:GA 的"导出账号"功能生成一个二维码,内容形如
 *   otpauth-migration://offline?data=<base64url(protobuf)>&x=<base64url(签名)>
 * 其中 data 是一段 protobuf,包含全部账号的种子。
 *
 * 手写 protobuf 解析的原因:引入 protobufjs 之类库对小程序体积代价过大,
 * 而这个 schema 极小,手写解析只需约 60 行。
 *
 * 签名字段 x 会被忽略:GA 用的是持有私钥的签名方案,公开验证密钥并不存在,
 * 无法验签,也无法防止攻击者伪造迁移二维码。因此本项目对迁移导入
 * 强制要求用户逐条确认服务与账户名,而不是静默全盘接收。
 *
 * Protobuf 结构:
 *   MigrationPayload {
 *     repeated OtpParameters otp_parameters = 1;
 *     int32 version = 2;
 *     int32 batch_size = 3;
 *     int32 batch_index = 4;
 *     int32 batch_id = 5;
 *   }
 *   OtpParameters {
 *     bytes  secret = 1;
 *     string name = 2;
 *     string issuer = 3;
 *     Algorithm algorithm = 4;  // 0 未指定 1 SHA1 2 SHA256 3 SHA512 4 MD5
 *     DigitCount digits = 5;    // 0 未指定 1 六位 2 八位
 *     OtpType type = 6;         // 0 未指定 1 HOTP 2 TOTP
 *     int64 counter = 7;
 *   }
 */

import { base32Encode } from '../base32.js';
import { utf8 } from '../crypto/primitives.js';
import type { OtpEntry } from '../otpauth.js';
import type { OtpAlgorithm } from '../totp.js';

class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  private varint(): number {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buf.length) {
      const byte = this.buf[this.pos++]!;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error('protobuf varint 过长,数据可能已损坏');
    }
    throw new Error('protobuf 数据意外结束');
  }

  private bytes(): Uint8Array {
    const length = this.varint();
    if (this.pos + length > this.buf.length) throw new Error('protobuf 字段长度越界');
    const out = this.buf.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /**
   * 跳过未知字段。
   * 必须暴露给 eachField 的回调使用——protobuf 的前向兼容性要求
   * 解析器能安全忽略自己不认识的字段,否则新版本导出的数据会解析失败。
   */
  skipField(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.bytes();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`不支持的 wire type: ${wireType}`);
    }
  }

  /** 逐字段解析,交给回调处理。 */
  eachField(callback: (fieldNo: number, wireType: number, reader: Reader) => void): void {
    while (!this.done) {
      const key = this.varint();
      const fieldNo = key >>> 3;
      const wireType = key & 0x07;
      if (fieldNo === 0) throw new Error('protobuf 字段号非法');
      callback(fieldNo, wireType, this);
    }
  }

  readVarintField(): number {
    return this.varint();
  }

  readBytesField(): Uint8Array {
    return this.bytes();
  }
}

function base64ToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  if (typeof globalThis.atob === 'function') {
    const binary = globalThis.atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  // Node 环境下无 atob,走 Buffer
  const nodeBuffer = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(padded, 'base64'));
  throw new Error('当前环境缺少 base64 解码能力');
}

function parseOtpParameters(buf: Uint8Array): Partial<OtpEntry> & { type: string; counter: number } {
  const reader = new Reader(buf);
  let secret = '';
  let name = '';
  let issuer = '';
  let algorithm: OtpAlgorithm = 'SHA1';
  let digits = 6;
  let type = 'totp';
  let counter = 0;

  reader.eachField((fieldNo, wireType, r) => {
    if (fieldNo === 1 && wireType === 2) secret = base32Encode(r.readBytesField());
    else if (fieldNo === 2 && wireType === 2) name = utf8.decode(r.readBytesField());
    else if (fieldNo === 3 && wireType === 2) issuer = utf8.decode(r.readBytesField());
    else if (fieldNo === 4 && wireType === 0) {
      const value = r.readVarintField();
      algorithm = value === 2 ? 'SHA256' : value === 3 ? 'SHA512' : 'SHA1';
    } else if (fieldNo === 5 && wireType === 0) {
      const value = r.readVarintField();
      digits = value === 2 ? 8 : 6;
    } else if (fieldNo === 6 && wireType === 0) {
      type = r.readVarintField() === 1 ? 'hotp' : 'totp';
    } else if (fieldNo === 7 && wireType === 0) {
      counter = r.readVarintField();
    } else {
      r.skipField(wireType);
    }
  });

  return { secret, account: name, issuer, algorithm, digits, type, counter };
}

/**
 * 解析 otpauth-migration:// 链接。
 * @returns 全部可迁移条目。type 为 hotp 的条目会被跳过(本项目只做 TOTP)。
 */
export function parseMigrationUri(uri: string, now: number = Date.now()): OtpEntry[] {
  const trimmed = uri.trim();
  if (!/^otpauth-migration:\/\//i.test(trimmed)) {
    throw new Error('不是有效的 Google Authenticator 迁移链接');
  }

  const qIndex = trimmed.indexOf('?');
  const query = qIndex === -1 ? '' : trimmed.slice(qIndex + 1);

  let dataParam: string | null = null;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq);
    if (key === 'data') {
      dataParam = pair.slice(eq + 1);
      break;
    }
  }

  if (!dataParam) {
    throw new Error('迁移链接中缺少 data 字段');
  }

  const payload = base64ToBytes(dataParam);
  const reader = new Reader(payload);
  const entries: OtpEntry[] = [];
  let counter = 0;

  reader.eachField((fieldNo, wireType, r) => {
    if (fieldNo === 1 && wireType === 2) {
      const parsed = parseOtpParameters(r.readBytesField());
      if (parsed.type !== 'totp') return;
      if (!parsed.secret) return;

      // GA 的 name 字段惯例是 "issuer:account",但独立的 issuer 字段也可能存在。
      // 两者都要处理:issuer 字段优先作为服务名,name 中的 "issuer:" 前缀需剥掉,
      // 否则账户名会变成 "GitHub:alice" 这种拼接结果。
      let accountName = (parsed.account ?? '').trim();
      let issuerName = (parsed.issuer ?? '').trim();
      const colon = accountName.indexOf(':');
      if (colon !== -1) {
        if (!issuerName) issuerName = accountName.slice(0, colon).trim();
        accountName = accountName.slice(colon + 1).trim();
      }

      counter += 1;
      entries.push({
        id: `mig-${now.toString(36)}-${counter.toString(36)}`,
        issuer: issuerName.trim() || '未知服务',
        account: accountName.trim() || '未命名账户',
        secret: parsed.secret.toUpperCase(),
        algorithm: parsed.algorithm ?? 'SHA1',
        digits: parsed.digits ?? 6,
        period: 30,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      r.skipField(wireType);
    }
  });

  if (entries.length === 0) {
    throw new Error('迁移数据中未找到可用的 TOTP 条目');
  }
  return entries;
}

/** 判断是否为迁移链接,UI 据此切换到批量导入流程。 */
export function isMigrationUri(value: string): boolean {
  return /^otpauth-migration:\/\//i.test(value.trim());
}
