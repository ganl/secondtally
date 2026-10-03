/**
 * 账号列表页。
 *
 * 计时器设计:
 * 用一个 1s 的 setInterval 而非每帧刷新。30 秒窗口只需秒级精度,
 * 每帧刷新在小程序里会明显掉帧且无收益。
 *
 * 生命周期:
 * onHide 时必须停掉定时器——后台运行的 setInterval 会持续消耗电量,
 * 在 iOS 上还可能被系统判定为异常而杀掉小程序。
 */

import { displayName } from '../../utils/core.mjs';

var appInstance = getApp<any>();

interface RowItem {
  id: string;
  issuer: string;
  account: string;
  favorite: boolean;
  /** 拆成两段是为了在中间加间隙,提升 6 位数字的可读性。 */
  codePart1: string;
  codePart2: string;
  percent: number;
  urgent: boolean;
  dimmed: boolean;
}

Page({
  data: {
    query: '',
    groups: [] as Array<{ label: string; items: RowItem[] }>,
    syncLabel: '未同步',
    syncClass: 'sync-off',
  },

  timer: null as ReturnType<typeof setInterval> | null,
  /** 缓存条目元数据,每秒只需重算验证码,不重复查保险库。 */
  entries: [] as any[],

  onLoad() {
    void this.bootstrap();
  },

  onShow() {
    // 从其他页面返回时数据可能已变,需重新读取
    if (this.entries.length > 0 || this.data.query !== '') {
      void this.bootstrap();
    }
    this.startTimer();
  },

  onHide() {
    this.stopTimer();
  },

  onUnload() {
    this.stopTimer();
  },

  async bootstrap() {
    const vault = appInstance.globalData.vault;
    if (!vault) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    // 已锁定则跳回解锁页——这是核心的安全边界,不能靠 UI 自觉
    if (!vault.isUnlocked()) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    try {
      this.entries = vault.listEntries(this.data.query);
      this.refreshCodes();
      this.refreshSyncStatus();
    } catch (error) {
      wx.showToast({
        title: error instanceof Error ? error.message : '读取失败',
        icon: 'none',
      });
    }
  },

  startTimer() {
    this.stopTimer();
    this.timer = setInterval(() => this.refreshCodes(), 1000);
  },

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  },

  refreshCodes() {
    const vault = appInstance.globalData.vault;
    if (!vault || !vault.isUnlocked()) {
      this.stopTimer();
      return;
    }

    try {
      const now = appInstance.globalData.time ? appInstance.globalData.time.now() : Date.now();
      const favorites: RowItem[] = [];
      const others: RowItem[] = [];

      for (const entry of this.entries) {
        const result = vault.generateCode(entry.id);
        const total = result.validUntil - result.validFrom;
        const elapsed = now - result.validFrom;
        const percent = Math.max(0, Math.min(100, (elapsed / total) * 100));
        // 剩余 5 秒内变黄,给用户心理准备
        const urgent = result.remaining <= 5000;

        const row: RowItem = {
          id: entry.id,
          issuer: entry.issuer,
          account: entry.account,
          favorite: !!entry.favorite,
          codePart1: result.code.slice(0, 3),
          codePart2: result.code.slice(3),
          percent,
          urgent,
          // 进度条走满即代表已过期,视觉上淡出
          dimmed: percent >= 99,
        };

        if (row.favorite) favorites.push(row);
        else others.push(row);
      }

      const groups: Array<{ label: string; items: RowItem[] }> = [];
      if (favorites.length > 0) groups.push({ label: '收藏', items: favorites });
      if (others.length > 0) groups.push({ label: '全部账号', items: others });

      this.setData({ groups });
    } catch (error) {
      // 保险库可能已被自动锁定
      this.stopTimer();
      wx.reLaunch({ url: '/pages/gate/index' });
    }
  },

  refreshSyncStatus() {
    const vault = appInstance.globalData.vault;
    if (!vault?.canSync?.()) {
      this.setData({ syncLabel: '未开启同步', syncClass: 'sync-off' });
      return;
    }
    const status = vault.getSyncStatus();
    if (status.lastError) {
      this.setData({ syncLabel: '同步异常', syncClass: 'sync-err' });
    } else if (status.lastSyncAt) {
      this.setData({ syncLabel: '已同步', syncClass: 'sync-ok' });
    } else {
      this.setData({ syncLabel: '待同步', syncClass: 'sync-off' });
    }
  },

  onSearch(event: WechatMiniprogram.Input) {
    const query = event.detail.value;
    this.setData({ query });
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) return;
    this.entries = vault.listEntries(query);
    this.refreshCodes();
  },

  onCopyCode(event: WechatMiniprogram.TouchEvent) {
    const id = event.currentTarget.dataset.id;
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    try {
      const code = vault.generateCode(id);
      wx.setClipboardData({ data: code.code });
      void vault.recordCodeCopied(id);
    } catch (error) {
      wx.showToast({ title: '复制失败', icon: 'none' });
    }
  },

  goEntry(event: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/entry/index?id=${event.currentTarget.dataset.id}` });
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/add/index' });
  },

  goAudit() {
    wx.navigateTo({ url: '/pages/audit/index' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/settings/index' });
  },
});
