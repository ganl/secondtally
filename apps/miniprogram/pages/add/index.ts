/**
 * 添加账号页 —— 入口分流。
 *
 * 三条路径:
 * 1. 扫码:处理 otpauth:// 单条导入
 * 2. 迁移:处理 otpauth-migration:// 批量导入(需二次确认,因为无法验签)
 * 3. 手动:跳到表单页
 */

import { isMigrationUri, parseMigrationUri } from '../../utils/core.mjs';
import { createScanner } from '../../utils/platform.mjs';

var appInstance = getApp<any>();

Page({
  data: {
    /** 批量迁移时的待确认列表。 */
    pendingBatch: [] as Array<{ issuer: string; account: string }>,
  },

  onLoad() {
    this.scanner = createScanner();
  },

  scanner: null as ReturnType<typeof createScanner> | null,

  async onScan() {
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    if (!this.scanner?.available()) {
      wx.showToast({ title: '当前微信版本不支持扫码,请升级', icon: 'none' });
      return;
    }

    try {
      const text = await this.scanner.scan();
      if (text === 'CANCELLED') return;

      if (isMigrationUri(text)) {
        // 迁移链接走批量流程
        void this.handleMigration(text);
        return;
      }

      const added = await vault.addFromScanned(text);
      if (added.length === 1) {
        wx.showToast({ title: `已添加 ${added[0].issuer}`, icon: 'success' });
        setTimeout(() => wx.navigateBack(), 800);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '添加失败';
      // 取消扫码不弹错误
      if (message !== 'CANCELLED') {
        wx.showModal({ title: '无法识别该二维码', content: message, showCancel: false });
      }
    }
  },

  /**
   * 批量迁移必须二次确认。
   * 原因:GA 的迁移二维码带签名,但公开验证密钥不存在,无法验签。
   * 也就是说攻击者可以伪造一个迁移二维码,把你自己的账号"塞"进来,
   * 或者诱导你导入钓鱼账号。逐条确认是当前协议下最诚实的做法。
   */
  async handleMigration(text: string) {
    const vault = appInstance.globalData.vault;
    if (!vault) return;

    let entries: Array<{ issuer: string; account: string }>;
    try {
      // 先解析预览,不落盘
      entries = parseMigrationUri(text, Date.now()).map((e) => ({
        issuer: e.issuer,
        account: e.account,
      }));
    } catch (error) {
      wx.showModal({
        title: '迁移数据无法解析',
        content: error instanceof Error ? error.message : '数据可能已损坏',
        showCancel: false,
      });
      return;
    }

    const preview = entries
      .slice(0, 8)
      .map((e, i) => `${i + 1}. ${e.issuer} · ${e.account}`)
      .join('\n');
    const more = entries.length > 8 ? `\n…共 ${entries.length} 个` : '';

    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: `确认导入 ${entries.length} 个账号?`,
        content: `${preview}${more}\n\n请逐一核对服务名称,只导入你认识的账号。`,
        confirmText: '确认导入',
        confirmColor: '#6366f1',
        success: (res) => resolve(Boolean(res.confirm)),
        fail: () => resolve(false),
      });
    });

    if (!confirmed) return;

    try {
      const added = await vault.addFromScanned(text);
      const skipped = entries.length - added.length;
      wx.showToast({
        title: skipped > 0 ? `导入 ${added.length} 个,跳过 ${skipped} 个重复` : `已导入 ${added.length} 个`,
        icon: 'success',
      });
      setTimeout(() => wx.navigateBack(), 1200);
    } catch (error) {
      wx.showModal({
        title: '导入失败',
        content: error instanceof Error ? error.message : '未知错误',
        showCancel: false,
      });
    }
  },

  onMigrate() {
    wx.showModal({
      title: '如何导出',
      content:
        '在 Google Authenticator 中:\n\n' +
        '1. 右上角菜单 → 导出账号\n' +
        '2. 选择要迁移的账号并确认\n' +
        '3. 用本应用扫描出现的二维码\n\n' +
        '注意:该二维码含全部账号种子,导出后请尽快完成迁移。',
      showCancel: false,
      confirmText: '我知道了',
      confirmColor: '#6366f1',
      success: () => this.onScan(),
    });
  },

  goManual() {
    wx.navigateTo({ url: '/pages/manual/index' });
  },
});
