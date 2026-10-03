/**
 * 小程序入口。
 *
 * 职责:组装平台适配器与 core 的 VaultService,并挂到 app 全局。
 * 页面只通过 getApp().vault 访问服务,不直接 new VaultService——
 * 保证全应用只有一个实例,自动锁定与状态才是全局一致的。
 */

import { VaultService, HttpSyncTransport, type RandomSource } from './utils/core.mjs';
import {
  createStore,
  createScanner,
  createClipboard,
  createCryptoRandom,
  ensureDeviceId,
  ensureDeviceName,
  sessionKey,
  TimeSource,
} from './utils/platform.mjs';

const app = getApp<any>();

/** 同步服务地址。生产环境需在小程序后台配置为合法域名。 */
const SYNC_BASE_URL = 'https://2fa.yourdomain.com';

App({
  globalData: {
    vault: null as VaultService | null,
    time: null as TimeSource | null,
    deviceId: '',
    deviceName: '',
    /** 同步传输层,未登录时为 null。 */
    transport: null as HttpSyncTransport | null,
  },

  /**
   * time 与 random 必须是实例字段而非 onLaunch 的局部变量。
   * connectSync() 在 onLaunch 之外执行,若它们是局部变量就会 ReferenceError。
   */
  time: null as TimeSource | null,
  random: null as RandomSource | null,

  async onLaunch() {
    const deviceId = ensureDeviceId();
    const deviceName = ensureDeviceName();
    const time = new TimeSource();
    const random: RandomSource = (n: number) => createCryptoRandom().bytes(n);

    this.time = time;
    this.random = random;

    const vault = new VaultService({
      store: createStore(),
      deviceId,
      deviceName,
      now: () => time.now(),
      random,
      // 3 分钟无操作自动锁定。2FA 场景下长时间保持解锁没有收益。
      lockAfterMs: 3 * 60 * 1000,
    });

    // 启动自检:core 内部会验证 TOTP 引擎,失败则抛错阻止启动
    await vault.init();

    this.globalData.vault = vault;
    this.globalData.time = time;
    this.globalData.deviceId = deviceId;
    this.globalData.deviceName = deviceName;
  },

  /**
   * 登录同步服务并挂上传输层。
   * 登录用的账户标识:小程序没有邮箱概念,这里用设备标识 + 用户自定义后缀,
   * 便于同一用户多设备归到同一账户。若要跨设备同步到同一账户,
   * 应在设置页让用户填写一个统一的账户名。
   */
  async connectSync(accountName: string, password: string) {
    const vault = this.globalData.vault;
    if (!vault) throw new Error('应用尚未初始化');

    const transport = new HttpSyncTransport({
      baseUrl: SYNC_BASE_URL,
      userId: accountName,
      // 会话键由 platform 统一生成,不在这里拼字符串——
      // 键名散落在两处时,改名必漏其中之一。
      loadSession: () => {
        try {
          const raw = wx.getStorageSync(sessionKey(accountName));
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      },
      saveSession: (session) => {
        wx.setStorageSync(sessionKey(accountName), JSON.stringify(session));
      },
      clearSession: () => {
        wx.removeStorageSync(sessionKey(accountName));
      },
      onSessionExpired: () => {
        wx.showToast({ title: '同步登录已过期', icon: 'none' });
      },
    });

    // 已登录则直接复用,否则注册/登录
    if (transport.isLoggedIn()) {
      // 尝试拉取一次,失败说明登录态失效
    } else {
      try {
        await transport.register(password);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (message.includes('已存在')) {
          await transport.login(password);
        } else {
          throw error;
        }
      }
    }

    this.globalData.transport = transport;

    // 切换传输层:core 的 deps 是只读的,所以这里重建一个服务实例。
    // 这是刻意的——传输层属于依赖,构造时注入比运行期改字段更安全。
    const previous = (this.globalData as any)._transportRef;
    if (previous !== transport) {
      const time = this.time!;
      const random = this.random!;
      const withTransport = new VaultService({
        store: createStore(),
        deviceId: this.globalData.deviceId,
        deviceName: this.globalData.deviceName,
        now: () => time.now(),
        random,
        transport,
        lockAfterMs: 3 * 60 * 1000,
      });
      await withTransport.init();

      // 若本机已有保险库,需要重新解锁才能继续。
      // 关键:解锁失败绝不能把用户锁在门外——保留原实例,
      // 让用户回到解锁页用主密码正常解锁即可,同步与否不影响本地使用。
      const initialized = await withTransport.hasVault();
      if (initialized) {
        try {
          await withTransport.unlock(password);
        } catch {
          wx.showToast({ title: '请重新解锁保险库', icon: 'none' });
          this.globalData.vault = withTransport;
          (this.globalData as any)._transportRef = transport;
          return transport;
        }
      }
      this.globalData.vault = withTransport;
      (this.globalData as any)._transportRef = transport;
    }

    return transport;
  },

  disconnectSync() {
    this.globalData.transport?.logout();
    this.globalData.transport = null;
    (this.globalData as any)._transportRef = null;
  },
});
