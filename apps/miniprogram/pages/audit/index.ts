/**
 * 审计页。
 *
 * 展示时把 action 映射为中文,并标注结果。
 * 不做任何过滤——审计的意义就在于"全都看得见",
 * 但 core 保证了这里不会出现验证码与种子。
 */

import { AUDIT_LABELS, AUDIT_OUTCOME_LABELS, formatRelative } from '../../utils/core.mjs';

var appInstance = getApp<any>();

Page({
  data: {
    events: [] as any[],
  },

  onShow() {
    const vault = appInstance.globalData.vault;
    if (!vault?.isUnlocked()) {
      wx.reLaunch({ url: '/pages/gate/index' });
      return;
    }

    const now = appInstance.globalData.time ? appInstance.globalData.time.now() : Date.now();
    const events = vault.listAudit().map((event: any) => ({
      id: event.id,
      label: AUDIT_LABELS[event.action] ?? event.action,
      detail: event.detail,
      outcome: event.outcome,
      outcomeLabel: AUDIT_OUTCOME_LABELS[event.outcome] ?? event.outcome,
      time: formatRelative(event.at, now),
    }));

    this.setData({ events });
  },
});
