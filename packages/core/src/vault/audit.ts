/**
 * 使用记录审计。
 *
 * 记录什么:谁(哪个条目)、什么时候、做了什么(生成/复制/校验)。
 * 绝不记录:验证码本身、主密码、种子明文。
 * 验证码一旦落盘就等于把有效凭据暴露给任何能读到本地数据的人,
 * 而它只有 30 秒有效期,留存没有审计价值,只有风险。
 */

export type AuditAction =
  | 'vault.create'
  | 'vault.unlock'
  | 'vault.lock'
  | 'vault.sync.push'
  | 'vault.sync.pull'
  | 'vault.sync.merge'
  | 'entry.add'
  | 'entry.remove'
  | 'entry.rename'
  | 'entry.favorite'
  | 'entry.code.generate'
  | 'entry.code.copy'
  | 'entry.migrate'
  | 'recovery.generate'
  | 'recovery.use';

export interface AuditEvent {
  id: string;
  at: number;
  action: AuditAction;
  /** 关联条目 id,若与具体条目无关则为空。 */
  entryId: string | null;
  /** 脱敏后的可读描述,例如 "GitHub"。 */
  detail: string;
  /** 结果:成功或被拒。 */
  outcome: 'success' | 'denied' | 'error';
}

let seq = 0;

function newAuditId(at: number): string {
  seq += 1;
  return `${at.toString(36)}-${seq.toString(36)}`;
}

export interface AuditInput {
  action: AuditAction;
  entryId?: string | null;
  detail?: string;
  outcome?: AuditEvent['outcome'];
  at?: number;
}

export function makeAuditEvent(input: AuditInput): AuditEvent {
  const at = input.at ?? Date.now();
  return {
    id: newAuditId(at),
    at,
    action: input.action,
    entryId: input.entryId ?? null,
    detail: input.detail ?? '',
    outcome: input.outcome ?? 'success',
  };
}

export const AUDIT_RETENTION = 500;

/** 追加事件并按上限截断,避免审计日志无限增长撑爆本地存储。 */
export function appendAudit(log: AuditEvent[], event: AuditEvent, limit: number = AUDIT_RETENTION): AuditEvent[] {
  const next = [event, ...log];
  return next.length > limit ? next.slice(0, limit) : next;
}

/** 人类可读的动作名称,供审计页直接展示。 */
export const AUDIT_LABELS: Record<AuditAction, string> = {
  'vault.create': '创建保险库',
  'vault.unlock': '解锁保险库',
  'vault.lock': '锁定保险库',
  'vault.sync.push': '上传到云端',
  'vault.sync.pull': '从云端拉取',
  'vault.sync.merge': '合并云端变更',
  'entry.add': '添加条目',
  'entry.remove': '删除条目',
  'entry.rename': '修改条目',
  'entry.favorite': '切换收藏',
  'entry.code.generate': '生成验证码',
  'entry.code.copy': '复制验证码',
  'entry.migrate': '批量迁移导入',
  'recovery.generate': '生成恢复码',
  'recovery.use': '使用恢复码',
};

export const AUDIT_OUTCOME_LABELS: Record<AuditEvent['outcome'], string> = {
  success: '成功',
  denied: '已拒绝',
  error: '出错',
};

/** 相对时间,用于审计列表。 */
export function formatRelative(at: number, now: number = Date.now()): string {
  const diff = now - at;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(at).toISOString().slice(0, 10);
}
