/**
 * 手动添加页。
 *
 * 关键:参数默认值选的是绝大多数服务的实际配置
 * (SHA1 / 6 位 / 30 秒)。让用户改这些参数只会增加出错概率,
 * 因此默认值明确标出,不确定就别动。
 */

var appInstance = getApp<any>();

const ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'];
const PERIODS = [30, 60, 15];

Page({
  data: {
    issuer: '',
    account: '',
    secret: '',
    algorithms: ALGORITHMS,
    algorithmIndex: 0,
    algorithm: 'SHA1',
    digitOptions: ['6', '8'],
    digitIndex: 0,
    digits: 6,
    periodOptions: PERIODS.map((p) => String(p)),
    periodIndex: 0,
    period: 30,
    error: '',
    canSubmit: false,
  },

  onIssuer(event: WechatMiniprogram.Input) {
    this.setData({ issuer: event.detail.value, error: '' });
    this.updateCanSubmit();
  },

  onAccount(event: WechatMiniprogram.Input) {
    this.setData({ account: event.detail.value, error: '' });
    this.updateCanSubmit();
  },

  onSecret(event: WechatMiniprogram.Input) {
    // 存储时统一去掉空格并转大写,减少后续比对出错
    const secret = event.detail.value.replace(/\s+/g, '').toUpperCase();
    this.setData({ secret, error: '' });
    this.updateCanSubmit();
  },

  onAlgorithm(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    this.setData({ algorithmIndex: index, algorithm: ALGORITHMS[index]! });
  },

  onDigits(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    this.setData({ digitIndex: index, digits: index === 1 ? 8 : 6 });
  },

  onPeriod(event: WechatMiniprogram.PickerChange) {
    const index = Number(event.detail.value);
    this.setData({ periodIndex: index, period: PERIODS[index]! });
  },

  updateCanSubmit() {
    const { issuer, account, secret } = this.data;
    // 种子至少 16 个 Base32 字符(约 10 字节),低于此值一定是输错
    const canSubmit = issuer.trim().length > 0 && account.trim().length > 0 && secret.length >= 16;
    this.setData({ canSubmit });
  },

  async onSubmit() {
    const { issuer, account, secret, algorithm, digits, period } = this.data;
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const entry = await vault.addManual({ issuer, account, secret, algorithm, digits, period });
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (error) {
      wx.hideLoading();
      this.setData({ error: error instanceof Error ? error.message : '保存失败' });
    }
  },
});
