/**
 * 微信小程序平台适配器。
 *
 * 这里是【唯一】允许出现 wx.* 的文件之一(另一个是 app.js/ts)。
 * core 与页面逻辑都不直接调用 wx API,好处是:
 * - 核心逻辑可在 Node 下单测
 * - 未来加 Web 端时,这些 wx 调用不需要出现在共享代码里
 */

/** 小程序没有 WebCrypto,需用 wx.getRandomBytes */
declare const wx: any;

import type { KeyValueStore, Scanner, Clipboard, CryptoRandom, SyncTransport } from '@twofa/core';

/** 存储适配器:包一层 Promise,让 core 用统一的异步接口。 */
export function createStore(): KeyValueStore {
  return {
    async get(key: string): Promise<string | null> {
      try {
        const value = wx.getStorageSync(key);
        // 小程序对不存在的 key 返回空字符串,需归一为 null
        return value === '' || value === undefined || value === null ? null : String(value);
      } catch {
        return null;
      }
    },
    async set(key: string, value: string): Promise<void> {
      wx.setStorageSync(key, value);
    },
    async remove(key: string): Promise<void> {
      wx.removeStorageSync(key);
    },
  };
}

/** 扫码适配器。 */
export function createScanner(): Scanner {
  return {
    available(): boolean {
      // 基础库 2.23+ 才有 scanCode 的完整能力
      return typeof wx.scanCode === 'function';
    },
    async scan(): Promise<string> {
      return new Promise((resolve, reject) => {
        wx.scanCode({
          // 只允许扫二维码,避免误触
          onlyFromCamera: false,
          scanType: ['qrCode'],
          success: (res: { result: string }) => resolve(res.result),
          fail: (err: { errMsg: string }) => {
            // 用户主动取消不是错误,不应弹错误提示
            if (String(err.errMsg).includes('cancel')) {
              reject(new Error('CANCELLED'));
            } else {
              reject(new Error('扫码失败,请重试'));
            }
          },
        });
      });
    },
  };
}

export function createClipboard(): Clipboard {
  return {
    async write(text: string): Promise<void> {
      wx.setClipboardData({ data: text });
    },
  };
}

/**
 * 加密随机源。
 * 优先 wx.getRandomValues;不可用时必须用 wx.getRandomBytes 兜底,
 * 绝不能退回 Math.random——那会让 GCM nonce 可预测,直接摧毁加密强度。
 */
export function createCryptoRandom(): CryptoRandom {
  return {
    bytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      if (typeof wx.getRandomValues === 'function') {
        // 小程序的 getRandomValues 接受 Uint8Array 并原地填充
        const filled = wx.getRandomValues(out);
        return filled instanceof Uint8Array ? filled : out;
      }
      if (typeof wx.getRandomBytes === 'function') {
        const res = wx.getRandomBytes(length);
        const buf = res.randomValues ?? res;
        for (let i = 0; i < length; i += 1) out[i] = buf[i] & 0xff;
        return out;
      }
      throw new Error('当前基础库不支持安全随机数,请升级微信后再使用本应用');
    },
  };
}

/**
 * 存储键的命名空间。
 *
 * 全部键都以此开头,"清空本机数据"按此前缀全清。
 *
 * 为什么用前缀而不是逐个列举键名:这个应用有六族键
 * (vault / lock / device.id / device.name / session.*),
 * 手工列举必然漏——漏掉 refreshToken 所在的 session 族,
 * 用户以为清空了,登录态其实还在。
 * 前缀匹配让"新增一个键"不再需要同步维护清空列表。
 */
export const STORAGE_NAMESPACE = 'aegis.';

/** 会话键:按账户名分桶,存的是登录态(含 refreshToken)。 */
const SESSION_KEY_PREFIX = `${STORAGE_NAMESPACE}session.`;

/** 稳定设备标识与展示名的键。 */
const DEVICE_KEY = `${STORAGE_NAMESPACE}device.id.v1`;
const DEVICE_NAME_KEY = `${STORAGE_NAMESPACE}device.name.v1`;

/**
 * 清空本机全部应用数据。
 *
 * 按命名空间前缀全清,而不是列举已知键——
 * 键会随功能增加,列举式清空迟早漏项。
 * 漏掉 session 族的后果是:用户点了"清空",但 refreshToken
 * 仍在 wx.storage 里,登录态没被真正清掉。
 *
 * 返回被删除的键数,便于调用方如实告知用户。
 */
export function wipeAllStorage(): number {
  let removed = 0;
  let keys: string[] = [];
  try {
    // getStorageInfoSync().keys 列出本小程序写入的全部键。
    keys = (wx.getStorageInfoSync?.().keys ?? []) as string[];
  } catch {
    // 拿不到清单时退回已知键,尽最大努力清。
  }
  const targets = new Set<string>(keys.filter((k) => k.startsWith(STORAGE_NAMESPACE)));
  // 兜底:即使清单拿不到,这四个键也必须清掉。
  targets.add(`${STORAGE_NAMESPACE}vault.v1`);
  targets.add(`${STORAGE_NAMESPACE}lock.v1`);
  targets.add(DEVICE_KEY);
  targets.add(DEVICE_NAME_KEY);
  for (const key of targets) {
    try {
      wx.removeStorageSync(key);
      removed += 1;
    } catch {
      /* 单个键失败不应中断整体清理 */
    }
  }
  return removed;
}

/** 当前登录态对应的存储键。 */
export function sessionKey(accountName: string): string {
  return `${SESSION_KEY_PREFIX}${accountName}`;
}

/**
 * 稳定的设备标识。
 * 首次启动生成后持久化,后续保持不变——
 * 若每次启动都变,同步冲突消解与审计会失去意义。
 */
export function ensureDeviceId(): string {
  try {
    const existing = wx.getStorageSync(DEVICE_KEY);
    if (existing) return String(existing);
  } catch {
    /* 落到生成逻辑 */
  }
  const bytes = createCryptoRandom().bytes(8);
  const id = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  wx.setStorageSync(DEVICE_KEY, id);
  return id;
}

/** 展示用设备名,便于在审计里区分来源。 */
export function ensureDeviceName(): string {
  try {
    const existing = wx.getStorageSync(DEVICE_NAME_KEY);
    if (existing) return String(existing);
  } catch {
    /* 落到生成逻辑 */
  }
  let name = '微信小程序';
  try {
    const info = wx.getAccountInfoSync?.();
    if (info?.miniProgram?.envVersion) {
      const env = info.miniProgram.envVersion;
      name = env === 'develop' ? '小程序·开发版' : env === 'trial' ? '小程序·体验版' : '小程序·正式版';
    }
  } catch {
    /* 保持默认名 */
  }
  wx.setStorageSync(DEVICE_NAME_KEY, name);
  return name;
}

/**
 * 时间源。
 * 关键:TOTP 对设备时钟偏差敏感——用户手机时间不准会导致验证码被服务端拒绝。
 * 这里允许用服务器返回的时间做校准,校准后本地用单调递进的偏移量,
 * 避免用户手动改系统时间导致倒计时错乱。
 */
export class TimeSource {
  private offsetMs = 0;
  private lastSyncedAt = 0;

  /** 记录一次时间同步。 */
  sync(serverTimeMs: number, roundTripMs: number) {
    // 用往返时间的一半作为误差修正
    const estimatedLocal = Date.now() - roundTripMs / 2;
    this.offsetMs = serverTimeMs - estimatedLocal;
    this.lastSyncedAt = Date.now();
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  get hasSynced(): boolean {
    return this.lastSyncedAt > 0;
  }

  get driftMs(): number {
    return this.offsetMs;
  }
}
