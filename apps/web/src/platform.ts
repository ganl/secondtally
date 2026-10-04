/**
 * Web 端入口。
 *
 * 与小程序共用同一份 core,唯一差异是平台适配器:
 * - 存储用 localStorage(而非 wx.setStorageSync)
 * - 剪贴板用 navigator.clipboard
 * - 随机源用 WebCrypto
 *
 * 关于 localStorage 存密文:localStorage 是明文可读的,
 * 任何 XSS 都能读走。所以我们只往里放 AES-GCM 密文——
 * 这正是端到端加密的第二道防线:即便脚本被注入,
 * 攻击者拿到的也只是需要主密码才能解开的密文。
 */

import {
  VaultService,
  HttpSyncTransport,
  type RandomSource,
  type KeyValueStore,
  type Scanner,
  type Clipboard,
  type CryptoRandom,
} from '@twofa/core';

const STORAGE_PREFIX = 'aegis.web.v1.';

function createStore(): KeyValueStore {
  return {
    async get(key) {
      return localStorage.getItem(STORAGE_PREFIX + key);
    },
    async set(key, value) {
      localStorage.setItem(STORAGE_PREFIX + key, value);
    },
    async remove(key) {
      localStorage.removeItem(STORAGE_PREFIX + key);
    },
  };
}

function createClipboard(): Clipboard {
  return {
    async write(text) {
      // Clipboard API 需要安全上下文(HTTPS 或 localhost),http 下不可用
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      // 回退方案:用临时 textarea + execCommand
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    },
  };
}

function createCryptoRandom(): CryptoRandom {
  return {
    bytes(length: number): Uint8Array {
      return crypto.getRandomValues(new Uint8Array(length));
    },
  };
}

function createScanner(): Scanner {
  return {
    available() {
      return typeof BarcodeDetector !== 'undefined';
    },
    async scan() {
      // Web 端扫码需要摄像头权限与 https,实现路径与小程序差异较大。
      // 这里明确告知用户去小程序完成扫码,而不是给一个半成品按钮。
      throw new Error('网页版暂不支持摄像头扫码,请使用微信小程序添加,或手动输入种子');
    },
  };
}

function ensureDeviceId(): string {
  const key = `${STORAGE_PREFIX}deviceId`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  localStorage.setItem(key, id);
  return id;
}

/** 服务器时间校准。TOTP 对时钟偏差敏感,浏览器时间不准会导致验证码被拒。 */
class TimeSource {
  private offsetMs = 0;

  async calibrate(endpoint: string): Promise<void> {
    try {
      const before = Date.now();
      const response = await fetch(`${endpoint}/health`, { cache: 'no-store' });
      const after = Date.now();
      if (!response.ok) return;
      const serverDate = response.headers.get('Date');
      if (!serverDate) return;
      const serverTime = new Date(serverDate).getTime();
      if (!Number.isFinite(serverTime)) return;
      // 用往返时间的一半修正,抵消单程网络延迟
      this.offsetMs = serverTime - (before + (after - before) / 2);
    } catch {
      // 校准失败不阻塞使用,只是时间偏移风险变高
    }
  }

  now(): number {
    return Date.now() + this.offsetMs;
  }

  get hasSynced(): boolean {
    return this.offsetMs !== 0;
  }

  get driftMs(): number {
    return this.offsetMs;
  }
}

export interface WebApp {
  vault: VaultService;
  time: TimeSource;
  transport: HttpSyncTransport | null;
  deviceId: string;
  connectSync(accountName: string, password: string, endpoint: string): Promise<void>;
  disconnectSync(): void;
}

declare global {
  interface Window {
    twofa: WebApp;
  }
}

export async function bootstrap(): Promise<WebApp> {
  const deviceId = ensureDeviceId();
  const time = new TimeSource();
  const random: RandomSource = (n: number) => createCryptoRandom().bytes(n);

  const endpoint = localStorage.getItem(`${STORAGE_PREFIX}endpoint`) ?? 'http://localhost:8787';
  void time.calibrate(endpoint);

  const build = (transport?: HttpSyncTransport) =>
    new VaultService({
      store: createStore(),
      deviceId,
      deviceName: `网页 · ${navigator.platform || '未知平台'}`,
      now: () => time.now(),
      random,
      transport,
      // 5 分钟无操作自动锁定
      lockAfterMs: 5 * 60 * 1000,
    });

  let vault = build();
  await vault.init();

  // 从 localStorage 恢复上次的同步登录态
  const savedAccount = localStorage.getItem(`${STORAGE_PREFIX}syncAccount`);
  if (savedAccount) {
    const session = localStorage.getItem(`${STORAGE_PREFIX}session.${savedAccount}`);
    if (session) {
      const transport = new HttpSyncTransport({
        baseUrl: endpoint,
        userId: savedAccount,
        loadSession: () => JSON.parse(session),
        saveSession: (next) => localStorage.setItem(`${STORAGE_PREFIX}session.${savedAccount}`, JSON.stringify(next)),
        clearSession: () => localStorage.removeItem(`${STORAGE_PREFIX}session.${savedAccount}`),
      });
      vault = build(transport);
      await vault.init();
      // 保险库仍需用户输入主密码解锁,这里不做自动解锁
    }
  }

  const app: WebApp = {
    vault,
    time,
    transport: null,
    deviceId,

    async connectSync(accountName: string, password: string, syncEndpoint: string) {
      localStorage.setItem(`${STORAGE_PREFIX}syncAccount`, accountName);
      localStorage.setItem(`${STORAGE_PREFIX}endpoint`, syncEndpoint);
      await time.calibrate(syncEndpoint);

      const transport = new HttpSyncTransport({
        baseUrl: syncEndpoint,
        userId: accountName,
        loadSession: () => {
          const raw = localStorage.getItem(`${STORAGE_PREFIX}session.${accountName}`);
          return raw ? JSON.parse(raw) : null;
        },
        saveSession: (session) =>
          localStorage.setItem(`${STORAGE_PREFIX}session.${accountName}`, JSON.stringify(session)),
        clearSession: () => localStorage.removeItem(`${STORAGE_PREFIX}session.${accountName}`),
      });

      if (!transport.isLoggedIn()) {
        try {
          await transport.register(password);
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          if (message.includes('已存在')) await transport.login(password);
          else throw error;
        }
      }

      const next = build(transport);
      await next.init();
      if (await next.hasVault()) {
        // 用同一个密码尝试解锁;失败则保持锁定,由 UI 提示用户输入主密码
        try {
          await next.unlock(password);
        } catch {
          /* 保持锁定 */
        }
      }
      app.vault = next;
      app.transport = transport;
    },

    disconnectSync() {
      app.transport?.logout();
      app.transport = null;
      const account = localStorage.getItem(`${STORAGE_PREFIX}syncAccount`);
      if (account) {
        localStorage.removeItem(`${STORAGE_PREFIX}session.${account}`);
        localStorage.removeItem(`${STORAGE_PREFIX}syncAccount`);
      }
    },
  };

  window.twofa = app;
  return app;
}

export { createScanner, createClipboard };
