/**
 * 条目详情页。
 *
 * 种子可见性:本页默认显示明文种子。这是个权衡——
 * 隐藏它并不能增加安全性(种子就在本机存储里),反而让用户无法核对。
 * 但我们提供了 toggle,方便在公共场合临时遮挡。
 */

var appInstance = getApp<any>();

Page({
  data: {
    id: '',
    entry: null as any,
    codePart1: '',
    codePart2: '',
    percent: 0,
    seconds: 30,
    urgent: false,
    expired: false,
  },

  timer: null as ReturnType<typeof setInterval> | null,

  onLoad(options: Record<string, string | undefined>) {
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }
    const id = options.id ?? '';
    this.setData({ id });

    const entry = vault.getEntry(id);
    if (!entry) {
      this.setData({ entry: null });
      return;
    }
    // 只取展示需要的字段,避免把 secret 之外的东西带进 setData 造成意外日志
    this.setData({
      entry: {
        id: entry.id,
        issuer: entry.issuer,
        account: entry.account,
        secret: entry.secret,
        algorithm: entry.algorithm,
        digits: entry.digits,
        period: entry.period,
        favorite: !!entry.favorite,
        note: entry.note ?? '',
      },
    });
    wx.setNavigationBarTitle({ title: entry.issuer });

    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1000);
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },

  refresh() {
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    try {
      const result = vault.generateCode(this.data.id);
      const total = result.validUntil - result.validFrom;
      const now = appInstance.globalData.time ? appInstance.globalData.time.now() : Date.now();
      const elapsed = now - result.validFrom;
      const percent = Math.max(0, Math.min(100, (elapsed / total) * 100));
      const seconds = Math.max(0, Math.ceil((result.validUntil - now) / 1000));

      this.setData({
        codePart1: result.code.slice(0, 3),
        codePart2: result.code.slice(3),
        percent,
        seconds,
        urgent: result.remaining <= 5000,
        expired: seconds === 0,
      });
    } catch (error) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  },

  onCopy() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    try {
      const code = vault.generateCode(this.data.id);
      wx.setClipboardData({ data: code.code });
      void vault.recordCodeCopied(this.data.id);
    } catch (error) {
      wx.showToast({ title: '复制失败', icon: 'none' });
    }
  },

  async onToggleFavorite() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    try {
      await vault.toggleFavorite(this.data.id);
      this.setData({ 'entry.favorite': !this.data.entry.favorite });
    } catch (error) {
      wx.showToast({ title: '操作失败', icon: 'none' });
    }
  },

  onEditAccount() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    wx.showModal({
      title: '修改账户名',
      editable: true,
      placeholderText: this.data.entry.account,
      success: async (res) => {
        if (!res.confirm || !res.content?.trim()) return;
        try {
          await vault.renameEntry(this.data.id, { account: res.content });
          this.setData({ 'entry.account': res.content.trim() });
        } catch (error) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      },
    });
  },

  onAddNote() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    wx.showModal({
      title: '备注',
      editable: true,
      placeholderText: '例如:备用邮箱、注册时间',
      content: this.data.entry.note,
      success: async (res) => {
        if (!res.confirm) return;
        try {
          await vault.renameEntry(this.data.id, { note: res.content ?? '' });
          this.setData({ 'entry.note': res.content ?? '' });
        } catch (error) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      },
    });
  },

  onRemove() {
    wx.showModal({
      title: '删除此账号?',
      content: '删除后需要重新扫码才能找回。请确认你已在服务端完成双重验证设置,或已保存恢复方式。',
      confirmText: '确认删除',
      confirmColor: '#dc2626',
      success: async (res) => {
        if (!res.confirm) return;
        const vault = appInstance.globalData.vault;
        if (!vault) return;
        try {
          await vault.removeEntry(this.data.id);
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 700);
        } catch (error) {
          wx.showToast({ title: '删除失败', icon: 'none' });
        }
      },
    });
  },
});
