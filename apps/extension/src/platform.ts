/**
 * 扩展端平台适配器。
 *
 * 与 Web 端几乎相同,差异在三处:
 * 1. 存储用 chrome.storage.local 而非 localStorage。
 *    扩展的 service worker 没有 window.localStorage,
 *    而且 localStorage 会在浏览器退出时被清理,不适合保存保险库。
 * 2. 随机源用 crypto.getRandomValues(扩展里拿不到 WebCrypto subtle,
 *    但 getRandomValues 是全局可用的)。
 * 3. 剪贴板直接用 navigator.clipboard:弹窗是获得焦点的真实 DOM 文档,
 *    MV3 对它的剪贴板限制与普通网页一致,不需要绕道 service worker。
 *
 * 另外扩展不做扫码:Chrome 扩展无法调起系统相机,
 * 强行引入 getUserMedia 也不符合作者商店的隐私政策。
 * 安全边界与 Web 端一致:storage里放的永远是 AES-GCM 密文。
 * 扩展被审查时看到的是一堆无法解读的 base64,这是设计预期。
 */

import type {
  KeyValueStore,
  Scanner,
  Clipboard,
  CryptoRandom,
} from '@twofa/core';

const STORAGE_PREFIX = 'aegis.ext.v1.';

/**
 * chrome.storage 的最小类型声明。
 * 完整类型来自 @types/chrome,为了不为一个扩展引入整套类型包,
 * 这里只声明实际用到的部分。
 */
interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}
declare const chrome: { storage: { local: ChromeStorageArea } };

function createStore(): KeyValueStore {
  return {
    async get(key) {
      const bag = await chrome.storage.local.get(STORAGE_PREFIX + key);
      const value = bag[STORAGE_PREFIX + key];
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await chrome.storage.local.set({ [STORAGE_PREFIX + key]: value });
    },
    async remove(key) {
      await chrome.storage.local.remove(STORAGE_PREFIX + key);
    },
  };
}

/**
 * 扩展没有扫码权限,这里明确返回不可用。
 * 用户在扩展里添加账号只能手动输入种子或粘贴 otpauth://链接。
 * 不留空实现是为了让 UI 能诚实地显示"该功能不可用",
 * 而不是点下去没反应。
 */
function createScanner(): Scanner {
  return {
    async scan() {
      throw new Error('扩展不支持扫码,请手动输入种子或粘贴 otpauth:// 链接');
    },
    available() {
      return false;
    },
  };
}

function createClipboard(): Clipboard {
  return {
    async write(text) {
      await navigator.clipboard.writeText(text);
    },
  };
}

function createRandom(): CryptoRandom {
  return {
    bytes(length) {
      const out = new Uint8Array(length);
      crypto.getRandomValues(out);
      return out;
    },
  };
}

export function createExtensionPlatform(): {
  store: KeyValueStore;
  scanner: Scanner;
  clipboard: Clipboard;
  random: CryptoRandom;
} {
  return {
    store: createStore(),
    scanner: createScanner(),
    clipboard: createClipboard(),
    random: createRandom(),
  };
}
