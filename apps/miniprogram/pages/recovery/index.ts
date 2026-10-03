/**
 * 恢复码页。
 *
 * 安全设计:
 * - 恢复码明文只在生成那一刻出现在页面上,离页即从内存移除。
 * - 服务端与本地存储里都只有哈希,拿回存储也无法还原明文。
 * - 核销失败不消耗任何码,避免用户输错几次就耗尽全部恢复码。
 */

var appInstance = getApp<any>();

Page({
  data: {
    mode: 'manage' as 'first' | 'manage',
    codes: [] as string[],
    input: '',
    error: '',
    success: '',
    remaining: 0,
    total: 10,
  },

  onLoad(options: Record<string, string | undefined>) {
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    if (options.mode === 'first') {
      const codes = appInstance.globalData.pendingRecoveryCodes ?? [];
      if (codes.length === 0) {
        // 没有待展示的码(例如直接进入本页),退到管理视图
        this.setData({ mode: 'manage' });
        this.refreshCounts();
        return;
      }
      this.setData({ mode: 'first', codes });
      // 立刻清掉 app 上的副本,避免长期驻留内存
      appInstance.globalData.pendingRecoveryCodes = null;
      wx.setNavigationBarTitle({ title: '保存恢复码' });
    } else {
      this.refreshCounts();
    }
  },

  refreshCounts() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    this.setData({
      remaining: vault.remainingRecovery(),
      total: 10,
    });
  },

  onCopyAll() {
    wx.setClipboardData({ data: this.data.codes.join('\n') });
  },

  onNext() {
    wx.reLaunch({ url: '/pages/vault/index' });
  },

  onInput(event: WechatMiniprogram.Input) {
    this.setData({ input: event.detail.value.toUpperCase(), error: '', success: '' });
  },

  async onConsume() {
    const { input } = this.data;
    if (!input.trim()) return;

    const vault = appInstance.globalData.vault;
    if (!vault) return;

    wx.showLoading({ title: '核销中…', mask: true });
    try {
      const result = await vault.consumeRecovery(input);
      wx.hideLoading();
      if (result.ok) {
        this.setData({ input: '', success: `核销成功。${result.reason}` });
        this.refreshCounts();
      } else {
        this.setData({ error: result.reason });
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({ error: error instanceof Error ? error.message : '核销失败' });
    }
  },

  onRegenerate() {
    wx.showModal({
      title: '重新生成恢复码?',
      content: '旧的恢复码会立即全部失效。如果你还没保存旧码,生成后将无法找回。',
      confirmText: '确认重新生成',
      confirmColor: '#dc2626',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '生成中…', mask: true });
        try {
          const vault = appInstance.globalData.vault;
          const codes = await vault.regenerateRecoveryCodes();
          wx.hideLoading();
          this.setData({ mode: 'first', codes, error: '', success: '' });
          wx.setNavigationBarTitle({ title: '保存恢复码' });
        } catch (error) {
          wx.hideLoading();
          this.setData({ error: error instanceof Error ? error.message : '生成失败' });
        }
      },
    });
  },

  goBack() {
    wx.navigateBack();
  },

  onUnload() {
    // 离开页面时抹掉明文恢复码
    this.setData({ codes: [] });
  },
});
