/**
 * 解锁 / 创建页面。
 *
 * 状态设计要点:
 * - 密码只存在 data 的临时字段,页面卸载即丢弃,绝不写入 storage。
 * - 解锁失败不区分"密码错误"与"数据损坏",避免给攻击者额外信息。
 * - 错误提示不残留:再次输入时立即清空,避免用户对着旧错误猜测。
 */

import { assessPassword } from '../../utils/core.mjs';

var appInstance = getApp<any>();

const STRENGTH_COLORS = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];

Page({
  data: {
    mode: 'unlock' as 'unlock' | 'create',
    password: '',
    confirm: '',
    error: '',
    canSubmit: false,
    strengthScore: 0,
    strengthPercent: 0,
    strengthColor: STRENGTH_COLORS[0],
    strengthLabel: '',
    strengthHint: '',
  },

  onLoad() {
    void this.detectMode();
  },

  async detectMode() {
    const vault = appInstance.globalData.vault;
    if (!vault) {
      wx.showToast({ title: '应用初始化中,请稍候', icon: 'none' });
      setTimeout(() => wx.reLaunch({ url: '/pages/gate/index' }), 500);
      return;
    }
    try {
      const hasVault = await vault.hasVault();
      this.setData({ mode: hasVault ? 'unlock' : 'create' });
      wx.setNavigationBarTitle({ title: hasVault ? '解锁' : '创建保险库' });
    } catch (error) {
      this.setData({ error: '读取本地数据失败,请重启应用' });
    }
  },

  onPassword(event: WechatMiniprogram.Input) {
    const password = event.detail.value;
    const patch: Record<string, unknown> = { password, error: '' };

    if (this.data.mode === 'create') {
      const strength = assessPassword(password);
      Object.assign(patch, {
        strengthScore: strength.score,
        strengthPercent: (strength.score / 4) * 100,
        strengthColor: STRENGTH_COLORS[strength.score] ?? STRENGTH_COLORS[0],
        strengthLabel: strength.label,
        strengthHint: strength.hint,
      });
      if (password !== this.data.confirm && this.data.confirm.length > 0) {
        patch.error = '两次输入的主密码不一致';
      }
    }

    // Page() 不支持 computed,派生状态需显式算好后 setData
    patch.canSubmit =
      this.data.mode === 'create'
        ? password.length >= 8 && password === this.data.confirm
        : password.length > 0;

    this.setData(patch as never);
  },

  onConfirm(event: WechatMiniprogram.Input) {
    const confirm = event.detail.value;
    const patch: Record<string, unknown> = { confirm };
    if (confirm.length > 0 && confirm !== this.data.password) {
      patch.error = '两次输入的主密码不一致';
    } else {
      patch.error = '';
    }
    this.setData(patch as never);
  },

  async onCreate() {
    const { password, confirm } = this.data;
    if (password !== confirm) {
      this.setData({ error: '两次输入的主密码不一致' });
      return;
    }
    if (password.length < 8) {
      this.setData({ error: '主密码至少需要 8 个字符' });
      return;
    }

    wx.showLoading({ title: '正在创建…', mask: true });
    try {
      const vault = appInstance.globalData.vault;
      const codes = await vault.create(password, confirm);
      // 恢复码只在创建时明文出现一次,必须让用户先保存
      appInstance.globalData.pendingRecoveryCodes = codes;
      wx.hideLoading();
      wx.redirectTo({ url: '/pages/recovery/index?mode=first' });
    } catch (error) {
      wx.hideLoading();
      this.setData({ error: error instanceof Error ? error.message : '创建失败,请重试' });
    }
  },

  async onUnlock() {
    const { password } = this.data;
    if (!password) return;

    wx.showLoading({ title: '正在解锁…', mask: true });
    try {
      const vault = appInstance.globalData.vault;
      await vault.unlock(password);
      wx.hideLoading();
      // 立即清空内存中的密码副本
      this.setData({ password: '' });
      wx.reLaunch({ url: '/pages/vault/index' });
    } catch (error) {
      wx.hideLoading();
      const message = error instanceof Error ? error.message : '解锁失败';
      this.setData({ error: message, password: '' });
      // 连续失败提示可能有人尝试爆破
      if (message.includes('解密失败')) {
        setTimeout(() => this.setData({ error: '' }), 4000);
      }
    }
  },

  goToUnlock() {
    this.setData({ mode: 'unlock', error: '', confirm: '' });
    wx.setNavigationBarTitle({ title: '解锁' });
  },

  goToCreate() {
    this.setData({ mode: 'create', error: '', confirm: '', password: '' });
    wx.setNavigationBarTitle({ title: '创建保险库' });
  },

  goToAbout() {
    wx.showModal({
      title: '关于安全性',
      content:
        '1. 主密码与账号种子永不离开你的设备,包括同步服务器。\n\n' +
        '2. 同步的只有 AES-256-GCM 密文,服务器无法解读。\n\n' +
        '3. 忘记主密码后,任何人都无法恢复你的账号——这是设计使然,不是缺陷。\n\n' +
        '4. 连续 3 分钟无操作会自动锁定。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#6366f1',
    });
  },

  onUnload() {
    // 页面销毁时抹掉密码
    this.setData({ password: '', confirm: '' });
  },
});
