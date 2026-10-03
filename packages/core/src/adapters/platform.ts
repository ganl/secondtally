/**
 * 平台适配器接口。
 *
 * core 定义契约,各端实现契约。这样 core 不需要认识 wx./window.,
 * 也让核心逻辑可以脱离平台单测。
 */

import type { RandomSource } from '../crypto/primitives.js';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** 扫码能力。 */
export interface Scanner {
  /** 调起扫码。返回扫码得到的原始文本(可能是 otpauth:// 或迁移链接)。 */
  scan(): Promise<string>;
  /** 是否可用。小程序需用户授权,浏览器端可能没有摄像头权限。 */
  available(): boolean;
}

/** 剪贴板。 */
export interface Clipboard {
  write(text: string): Promise<void>;
}

/** 加密随机源,优先用平台原生实现(小程序 wx.getRandomValues)。 */
export interface CryptoRandom {
  bytes(length: number): Uint8Array;
}

/** 同步传输层。 */
export interface SyncTransport {
  /** 拉取远端密文。revision 未知时传 null。 */
  pull(sinceRevision: number | null): Promise<RemoteRecord | null>;
  /**
   * 推送本地密文。
   * baseRevision 为服务端当前版本,服务端据此做条件写入,
   * 若不匹配会返回冲突而不是覆盖,避免静默丢数据。
   */
  push(payload: PushPayload): Promise<PushResult>;
}

export interface RemoteRecord {
  envelope: unknown;
  revision: number;
  updatedAt: number;
  deviceId: string;
}

export interface PushPayload {
  envelope: unknown;
  updatedAt: number;
  deviceId: string;
  baseRevision: number | null;
}

export interface PushResult {
  ok: boolean;
  /** 写入后的服务端版本号。 */
  revision: number;
  /** 若发生冲突,服务端当前记录,客户端应拉取后合并再推。 */
  conflict: RemoteRecord | null;
}

export interface Platform {
  store: KeyValueStore;
  scanner: Scanner;
  clipboard: Clipboard;
  random: CryptoRandom;
  /** 本机稳定标识,用于同步冲突消解与审计。 */
  deviceId: string;
  /** 展示用设备名。 */
  deviceName: string;
  /** 当前时间(毫秒)。可被服务器时间校准覆盖。 */
  now(): number;
}

export function randomFrom(random: CryptoRandom): RandomSource {
  return (length: number) => random.bytes(length);
}
