/**
 * 设置页。
 *
 * 危险操作的设计原则:
 * - 导出/导入/清空都要求显式二次确认,并说明后果。
 * - 清空前明确告知"这会导致所有账号无法找回",而不是轻描淡写。
 * - 导入用主密码验证后才覆盖,且验证失败不改动本机数据(由 core 保证)。
 */

import { wipeAllStorage } from '../../utils/platform.mjs';

var appInstance = getApp<any>();

Page({
  data: {
    accountName: '',
    syncPassword: '',
    syncEnabled: false,
    syncStateLabel: '未同步',
    syncError: '',
    syncSuccess: '',
    deviceId: '',
    driftLabel: '未校准',
  },

  onShow() {
    this.refresh();
  },

  refresh() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    const status = vault.getSyncStatus();
    const time = appInstance.globalData.time;

    this.setData({
      syncEnabled: appInstance.globalData.transport !== null,
      deviceId: appInstance.globalData.deviceId,
      driftLabel: time?.hasSynced
        ? `${time.driftMs >= 0 ? '+' : ''}${Math.round(time.driftMs / 1000)} 秒`
        : '未校准',
      syncStateLabel: status.lastError
        ? '异常'
        : status.lastSyncAt
          ? `已同步 · ${new Date(status.lastSyncAt).toLocaleTimeString()}`
          : '待首次同步',
    });
  },

  onAccountName(event: WechatMiniprogram.Input) {
    this.setData({ accountName: event.detail.value, syncError: '' });
  },

  onSyncPassword(event: WechatMiniprogram.Input) {
    this.setData({ syncPassword: event.detail.value, syncError: '' });
  },

  async onConnectSync() {
    const { accountName, syncPassword } = this.data;
    if (!accountName.trim()) {
      this.setData({ syncError: '请填写同步账户名' });
      return;
    }
    if (syncPassword.length < 8) {
      this.setData({ syncError: '登录密码至少 8 位' });
      return;
    }

    wx.showLoading({ title: '连接中…', mask: true });
    try {
      await appInstance.connectSync(accountName.trim(), syncPassword);
      wx.hideLoading();
      this.setData({ syncEnabled: true, syncPassword: '', syncError: '', syncSuccess: '同步已开启' });
      this.refresh();
    } catch (error) {
      wx.hideLoading();
      this.setData({ syncError: error instanceof Error ? error.message : '连接失败' });
    }
  },

  async onSyncNow() {
    const vault = appInstance.globalData.vault;
    if (!vault?.canSync?.()) {
      this.setData({ syncError: '同步未开启' });
      return;
    }

    wx.showLoading({ title: '同步中…', mask: true });
    try {
      const result = await vault.sync();
      wx.hideLoading();
      if (result.ok) {
        this.setData({
          syncSuccess: result.merged > 0 ? `同步完成,合并了 ${result.merged} 项变更` : '同步完成',
          syncError: '',
        });
      } else {
        this.setData({ syncError: result.message });
      }
      this.refresh();
    } catch (error) {
      wx.hideLoading();
      this.setData({ syncError: error instanceof Error ? error.message : '同步失败' });
    }
  },

  onDisconnectSync() {
    wx.showModal({
      title: '关闭同步?',
      content: '关闭后本机数据仍保留,但不再与云端保持一致。若云端有更新的数据,重新开启同步时会被合并进来。',
      success: (res) => {
        if (!res.confirm) return;
        appInstance.disconnectSync();
        this.setData({ syncEnabled: false, syncSuccess: '', syncError: '' });
        this.refresh();
      },
    });
  },

  async onExport() {
    const vault = appInstance.globalData.vault;
    if (!vault) return;
    try {
      const raw = await vault.exportVault();
      // 写到临时文件,让用户通过"文件"分享出去
      const filePath = `${wx.env.USER_DATA_PATH}/twofa-vault.json`;
      const fs = wx.getFileSystemManager();
      fs.writeFileSync(filePath, raw, 'utf8');
      wx.showShareMenu({ menus: ['shareFileMessage'] });
      wx.showModal({
        title: '已生成加密文件',
        content: `文件位置:\n${filePath}\n\n该文件已用你的主密码加密。即便文件泄露,他人也无法解读。\n点击右上角菜单可发送给其他设备。`,
        showCancel: false,
        confirmText: '知道了',
        confirmColor: '#6366f1',
      });
    } catch (error) {
      wx.showToast({ title: error instanceof Error ? error.message : '导出失败', icon: 'none' });
    }
  },

  onImport() {
    wx.showModal({
      title: '导入保险库文件',
      editable: true,
      placeholderText: '粘贴导出的 JSON 内容',
      success: (res) => {
        if (!res.confirm || !res.content?.trim()) return;
        const raw = res.content.trim();

        wx.showModal({
          title: '导入会覆盖本机数据',
          content: '导入的保险库将替换本机现有的全部账号。请确认你已备份重要条目。',
          confirmText: '继续',
          confirmColor: '#dc2626',
          success: async (confirmRes) => {
            if (!confirmRes.confirm) return;
            const password = await this.askPassword();
            if (!password) return;
            try {
              const vault = appInstance.globalData.vault;
              await vault.importVault(raw, password);
              wx.showToast({ title: '导入成功', icon: 'success' });
              setTimeout(() => wx.reLaunch({ url: '/pages/vault/index' }), 800);
            } catch (error) {
              wx.showModal({
                title: '导入失败',
                content: error instanceof Error ? error.message : '未知错误',
                showCancel: false,
              });
            }
          },
        });
      },
    });
  },

  askPassword(): Promise<string | null> {
    return new Promise((resolve) => {
      wx.showModal({
        title: '输入主密码',
        editable: true,
        placeholderText: '导出时使用的主密码',
        success: (res) => {
          resolve(res.confirm && res.content ? res.content : null);
        },
        fail: () => resolve(null),
      });
    });
  },

  onWipe() {
    wx.showModal({
      title: '清空本机数据',
      content:
        '这会永久删除本机的保险库与恢复码。\n\n' +
        '由于主密码不会被上传,清空后若没有其他设备上的副本,你的所有账号都将无法找回。\n\n确定继续吗?',
      confirmText: '我确定,清空',
      confirmColor: '#dc2626',
      success: (res) => {
        if (!res.confirm) return;
        // 二次确认:不可逆操作值得多一次点击
        wx.showModal({
          title: '最后确认',
          content: '真的要删除全部数据吗?此操作无法撤销。',
          confirmText: '删除',
          confirmColor: '#dc2626',
          success: async (finalRes) => {
            if (!finalRes.confirm) return;
            try {
              // 按命名空间前缀全清,含登录态(session 族)。
              // 早先这里硬编码三个键,漏掉了 session 与 device.name——
              // 用户以为清空了,refreshToken 其实还在 storage 里。
              const removed = wipeAllStorage();
              wx.showToast({ title: `已清空 ${removed} 项`, icon: 'none' });
              setTimeout(() => wx.reLaunch({ url: '/pages/gate/index' }), 800);
            } catch (error) {
              wx.showToast({ title: '清空失败', icon: 'none' });
            }
          },
        });
      },
    });
  },

  goRecovery() {
    wx.navigateTo({ url: '/pages/recovery/index' });
  },

  goAudit() {
    wx.navigateTo({ url: '/pages/audit/index' });
  },
});
