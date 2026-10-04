/**
 * Web 端 UI。
 *
 * 用原生 DOM 而非框架:界面只有一个列表加几个弹窗,
 * 引入 React/Vue 会为了几十行渲染逻辑增加几百 KB 依赖,
 * 而这个应用的核心价值在加密与同步,不在视图层。
 *
 * 关键安全实践:
 * - 所有文本内容用 textContent 赋值,不用 innerHTML。
 *   条目名与备注来自用户输入或扫码结果,一旦用 innerHTML 拼接,
 *   一个叫 <img onerror=...> 的服务名就能执行任意脚本。
 *   即便保险库已加密,页面被注入后仍能读取解密后的内存数据。
 */

import {
  assessPassword,
  AUDIT_LABELS,
  AUDIT_OUTCOME_LABELS,
  formatRelative,
  parseOtpAuthUri,
  type OtpEntry,
} from '@twofa/core';
import { bootstrap } from './platform.js';

const app = document.getElementById('app')!;

// ---------- 工具 ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string; text?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (value !== undefined && value !== null) {
      (node as any)[key] = value;
    }
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(message: string) {
  document.querySelector('.toast')?.remove();
  const node = el('div', { class: 'toast', text: message });
  document.body.append(node);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 2400);
}

function clearApp() {
  app.innerHTML = '';
  return app;
}

// ---------- 视图:解锁 / 创建 ----------

function renderGate() {
  const root = clearApp();
  root.append(
    el('div', { class: 'brand' }, [
      el('h1', { text: 'SecondTally' }),
      el('span', { class: 'tag', text: '端到端加密的双重认证器' }),
    ]),
  );

  void window.twofa.vault.hasVault().then((exists) => {
    if (exists) renderUnlock(root);
    else renderCreate(root);
  });
}

function renderCreate(root: HTMLElement) {
  const card = el('div', { class: 'card' });
  const alert = el('div', { class: 'alert alert-warn' });
  alert.append(
    el('div', {
      text:
        '主密码是本应用唯一能解密你账号的凭据。它不会被上传到任何服务器,也无法找回——请务必牢记。',
    }),
  );

  const pwInput = el('input', { type: 'password', placeholder: '至少 8 位,建议混合大小写、数字与符号' });
  const confirmInput = el('input', { type: 'password', placeholder: '再次输入以确认' });
  const bar = el('div', { class: 'strength-bar' }, [el('div', { class: 'strength-fill', style: 'width:0%' })]);
  const strengthText = el('span', { class: 'strength-text' });
  const errorBox = el('div', { class: 'alert alert-error' });
  errorBox.style.display = 'none';
  const submit = el('button', { class: 'btn', text: '创建保险库' }) as HTMLButtonElement;

  const colors = ['#ef4444', '#f97316', '#eab308', '#84cc16', '#22c55e'];

  pwInput.addEventListener('input', () => {
    const strength = assessPassword(pwInput.value);
    (bar.firstChild as HTMLElement).style.width = `${(strength.score / 4) * 100}%`;
    (bar.firstChild as HTMLElement).style.background = colors[strength.score]!;
    strengthText.textContent = `${strength.label} · ${strength.hint}`;
  });

  submit.addEventListener('click', async () => {
    errorBox.style.display = 'none';
    if (pwInput.value !== confirmInput.value) {
      errorBox.textContent = '两次输入的主密码不一致';
      errorBox.style.display = 'block';
      return;
    }
    submit.disabled = true;
    submit.textContent = '正在创建…';
    try {
      const codes = await window.twofa.vault.create(pwInput.value, confirmInput.value);
      // 立即清空 DOM 里的密码
      pwInput.value = '';
      confirmInput.value = '';
      renderRecoveryCodes(codes);
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : '创建失败';
      errorBox.style.display = 'block';
      submit.disabled = false;
      submit.textContent = '创建保险库';
    }
  });

  card.append(
    alert,
    el('div', { class: 'field' }, [el('label', { text: '设置主密码' }), pwInput, bar, strengthText]),
    el('div', { class: 'field' }, [el('label', { text: '确认主密码' }), confirmInput]),
    errorBox,
    submit,
  );
  root.append(card);
  pwInput.focus();
}

function renderUnlock(root: HTMLElement) {
  const card = el('div', { class: 'card' });
  const pwInput = el('input', { type: 'password', placeholder: '请输入主密码' });
  const errorBox = el('div', { class: 'alert alert-error' });
  errorBox.style.display = 'none';
  const submit = el('button', { class: 'btn', text: '解锁' }) as HTMLButtonElement;

  const attempt = async () => {
    errorBox.style.display = 'none';
    if (!pwInput.value) return;
    submit.disabled = true;
    submit.textContent = '正在解锁…';
    try {
      await window.twofa.vault.unlock(pwInput.value);
      pwInput.value = '';
      renderVault();
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : '解锁失败';
      errorBox.style.display = 'block';
      pwInput.value = '';
      submit.disabled = false;
      submit.textContent = '解锁';
    }
  };

  submit.addEventListener('click', attempt);
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attempt();
  });

  card.append(
    el('div', { class: 'field' }, [el('label', { text: '主密码' }), pwInput]),
    errorBox,
    submit,
  );
  root.append(card);
  pwInput.focus();
}

// ---------- 视图:一次性恢复码 ----------

function renderRecoveryCodes(codes: string[]) {
  const root = clearApp();
  const card = el('div', { class: 'card' });
  const list = el('div', { class: 'copy-codes' });
  codes.forEach((code, i) => {
    list.append(el('div', { text: `${i + 1}. ${code}` }));
  });

  const copyBtn = el('button', { class: 'btn btn-ghost', text: '复制全部' }) as HTMLButtonElement;
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(codes.join('\n'));
    copyBtn.textContent = '已复制';
  });

  const next = el('button', { class: 'btn', text: '我已妥善保存' }) as HTMLButtonElement;
  next.addEventListener('click', () => renderVault());

  card.append(
    el('div', {
      class: 'alert alert-warn',
      text: `这 ${codes.length} 个恢复码每个只能使用一次,只在此刻显示一次。关闭后无法再次查看。`,
    }),
    list,
    copyBtn,
    el('div', { style: 'height:10px' }),
    next,
  );
  root.append(card);
}

// ---------- 视图:主列表 ----------

let timer: ReturnType<typeof setInterval> | null = null;
let searchQuery = '';

function renderVault() {
  const root = clearApp();
  const vault = window.twofa.vault;

  const topbar = el('div', { class: 'topbar' });
  const brand = el('div', { class: 'brand', style: 'margin:0' }, [
    el('h1', { text: 'SecondTally' }),
  ]);

  const syncLabel = el('span', { class: 'sync-state' });
  const actions = el('div', { class: 'actions' });

  const addBtn = el('button', { class: 'btn btn-inline', text: '+ 添加' });
  addBtn.addEventListener('click', () => renderAddModal());

  const auditBtn = el('button', { class: 'btn-ghost btn-inline', text: '使用记录' });
  auditBtn.addEventListener('click', () => renderAuditModal());

  const settingsBtn = el('button', { class: 'btn-ghost btn-inline', text: '设置' });
  settingsBtn.addEventListener('click', () => renderSettingsModal());

  actions.append(addBtn, auditBtn, settingsBtn);
  topbar.append(brand, syncLabel, actions);

  const search = el('input', { class: 'search', placeholder: '搜索服务或账户' }) as HTMLInputElement;
  search.addEventListener('input', () => {
    searchQuery = search.value;
    renderEntries();
  });

  const listWrap = el('div');
  root.append(topbar, search, listWrap);

  const renderSync = () => {
    if (!vault.canSync()) {
      syncLabel.innerHTML = '';
      syncLabel.append(el('span', { class: 'dot dot-off' }), document.createTextNode('未开启同步'));
      return;
    }
    const status = vault.getSyncStatus();
    syncLabel.innerHTML = '';
    if (status.lastError) {
      syncLabel.append(el('span', { class: 'dot dot-err' }), document.createTextNode('同步异常'));
    } else if (status.lastSyncAt) {
      syncLabel.append(el('span', { class: 'dot dot-ok' }), document.createTextNode('已同步'));
    } else {
      syncLabel.append(el('span', { class: 'dot dot-off' }), document.createTextNode('待同步'));
    }
  };

  const renderEntries = () => {
    listWrap.innerHTML = '';
    let entries: OtpEntry[];
    try {
      entries = vault.listEntries(searchQuery);
    } catch {
      return;
    }

    if (entries.length === 0) {
      listWrap.append(
        el('div', { class: 'empty' }, [
          el('h3', { text: searchQuery ? '没有匹配的账号' : '还没有添加任何账号' }),
          el('p', {
            text: searchQuery
              ? '换个关键词试试'
              : '点击「+ 添加」输入种子,或从小程序扫码添加',
          }),
        ]),
      );
      return;
    }

    const favorites = entries.filter((e) => e.favorite);
    const others = entries.filter((e) => !e.favorite);

    const appendGroup = (label: string, items: OtpEntry[]) => {
      if (items.length === 0) return;
      listWrap.append(el('div', { class: 'section-label', text: `${label} · ${items.length}` }));
      for (const entry of items) listWrap.append(buildEntryRow(entry));
    };

    appendGroup('收藏', favorites);
    appendGroup('全部账号', others);
  };

  const buildEntryRow = (entry: OtpEntry) => {
    const codeEl = el('div', { class: 'code' });
    const barFill = el('div', { class: 'bar-fill', style: 'width:0%' });
    const secs = el('div', { class: 'secs' });

    const codeBox = el('div', { class: 'code-box' }, [codeEl, el('div', { class: 'bar' }, [barFill]), secs]);
    codeBox.addEventListener('click', () => {
      const result = vault.generateCode(entry.id);
      void navigator.clipboard.writeText(result.code);
      void vault.recordCodeCopied(entry.id);
      toast(`已复制 ${entry.issuer} 的验证码`);
    });

    const row = el('div', { class: 'entry' }, [
      el('div', { class: 'entry-info' }, [
        el('div', { class: 'entry-issuer' }, [
          entry.favorite ? el('span', { class: 'star', text: '★' }) : null,
          document.createTextNode(entry.issuer),
        ].filter(Boolean) as Node[]),
        el('div', { class: 'entry-account', text: entry.account }),
      ]),
      codeBox,
    ]);

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      renderEntryModal(entry);
    });

    // 缓存引用供定时器更新
    (row as any).__update = () => {
      const result = vault.generateCode(entry.id);
      codeEl.innerHTML = '';
      codeEl.append(
        el('span', { class: 'code-sep', text: result.code.slice(0, 3) }),
        document.createTextNode(result.code.slice(3)),
      );
      const total = result.validUntil - result.validFrom;
      const elapsed = Date.now() - result.validFrom;
      const percent = Math.max(0, Math.min(100, (elapsed / total) * 100));
      barFill.style.width = `${percent}%`;
      barFill.className = percent > 83 ? 'bar-fill urgent' : 'bar-fill';
      codeEl.className = percent >= 99 ? 'code expired' : 'code';
      const remain = Math.max(0, Math.ceil((result.validUntil - Date.now()) / 1000));
      secs.textContent = `${remain} 秒`;
    };
    (row as any).__update();
    return row;
  };

  const tick = () => {
    if (!window.twofa.vault.isUnlocked()) {
      if (timer) clearInterval(timer);
      timer = null;
      renderGate();
      return;
    }
    listWrap.querySelectorAll('.entry').forEach((node) => {
      (node as any).__update?.();
    });
  };

  if (timer) clearInterval(timer);
  timer = setInterval(tick, 1000);

  renderSync();
  renderEntries();
}

// ---------- 弹窗:添加 ----------

function closeModal() {
  document.querySelector('.modal-backdrop')?.remove();
}

function openModal(title: string, body: HTMLElement, footer?: HTMLElement) {
  closeModal();
  const backdrop = el('div', { class: 'modal-backdrop' });
  const modal = el('div', { class: 'modal' }, [el('h3', { text: title }), body]);
  if (footer) modal.append(footer);
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.body.append(backdrop);
  return modal;
}

function renderAddModal() {
  const body = el('div');
  const alert = el('div', { class: 'alert alert-error' });
  alert.style.display = 'none';

  const issuer = el('input', { type: 'text', placeholder: 'GitHub' });
  const account = el('input', { type: 'text', placeholder: 'alice@example.com' });
  const secret = el('input', { type: 'text', class: 'mono', placeholder: 'JBSWY3DPEHPK3PXP' });
  const algorithm = el('select', {});
  for (const algo of ['SHA1', 'SHA256', 'SHA512']) {
    algorithm.append(el('option', { value: algo, text: algo }));
  }

  const submit = el('button', { class: 'btn', text: '保存' }) as HTMLButtonElement;
  submit.addEventListener('click', async () => {
    alert.style.display = 'none';
    submit.disabled = true;
    try {
      await window.twofa.vault.addManual({
        issuer: issuer.value,
        account: account.value,
        secret: secret.value,
        algorithm: algorithm.value as 'SHA1',
      });
      closeModal();
      toast('已添加');
      renderVault();
    } catch (error) {
      alert.textContent = error instanceof Error ? error.message : '添加失败';
      alert.style.display = 'block';
      submit.disabled = false;
    }
  });

  body.append(
    alert,
    el('div', { class: 'field' }, [el('label', { text: '服务名称' }), issuer]),
    el('div', { class: 'field' }, [el('label', { text: '账户' }), account]),
    el('div', { class: 'field' }, [el('label', { text: '种子密钥(Base32)' }), secret]),
    el('div', { class: 'field' }, [el('label', { text: '算法' }), algorithm]),
    el('div', {
      class: 'hint',
      text: '网页版不支持摄像头扫码,建议在微信小程序中扫码添加。种子可在服务网站的「安全设置」中找到。',
    }),
    submit,
  );

  const modal = openModal('添加账号', body);
  modal.append(el('div', { style: 'height:10px' }), el('button', { class: 'btn-ghost', text: '关闭', onclick: closeModal }));
  issuer.focus();
}

// ---------- 弹窗:条目详情 ----------

function renderEntryModal(entry: OtpEntry) {
  const body = el('div');
  const codeEl = el('div', {
    class: 'code',
    style: 'font-size:32px;text-align:center;margin-bottom:16px',
  });

  const stat = (label: string, value: string) => el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label', text: label }),
    el('span', { text: value }),
  ]);

  const favBtn = el('button', { class: 'btn-ghost', text: entry.favorite ? '取消收藏' : '收藏' });
  favBtn.addEventListener('click', async () => {
    await window.twofa.vault.toggleFavorite(entry.id);
    closeModal();
    renderVault();
  });

  const delBtn = el('button', { class: 'btn-ghost btn-danger', text: '删除此账号' });
  delBtn.addEventListener('click', async () => {
    if (!confirm('确定删除?删除后需要重新扫码才能找回。')) return;
    await window.twofa.vault.removeEntry(entry.id);
    closeModal();
    toast('已删除');
    renderVault();
  });

  body.append(
    codeEl,
    stat('服务', entry.issuer),
    stat('账户', entry.account),
    stat('种子', entry.secret),
    stat('算法', entry.algorithm),
    stat('位数 / 周期', `${entry.digits} 位 / ${entry.period} 秒`),
    el('div', {
      class: 'alert alert-warn',
      style: 'margin-top:16px',
      text: '种子等同于账号的第二把钥匙。任何拿到它的人都能生成你的验证码,请勿分享。',
    }),
    favBtn,
    el('div', { style: 'height:8px' }),
    delBtn,
  );

  openModal(entry.issuer, body);

  const timer2 = setInterval(() => {
    const result = window.twofa.vault.generateCode(entry.id);
    codeEl.innerHTML = '';
    codeEl.append(
      el('span', { class: 'code-sep', text: result.code.slice(0, 3) }),
      document.createTextNode(result.code.slice(3)),
    );
    codeEl.style.cursor = 'pointer';
    codeEl.onclick = () => {
      void navigator.clipboard.writeText(result.code);
      toast('已复制');
    };
  }, 1000);
  const observer = new MutationObserver(() => {
    clearInterval(timer2);
    observer.disconnect();
  });
  observer.observe(document.body, { childList: true });
  const check = setInterval(() => {
    if (!document.querySelector('.modal-backdrop')) {
      clearInterval(timer2);
      clearInterval(check);
    }
  }, 500);
}

// ---------- 弹窗:审计 ----------

function renderAuditModal() {
  const body = el('div');
  const now = window.twofa.time.now();
  const events = window.twofa.vault.listAudit();

  if (events.length === 0) {
    body.append(el('p', { class: 'hint', text: '暂无记录' }));
  } else {
    for (const event of events) {
      body.append(
        el('div', { class: 'audit-item' }, [
          el('span', {}, [
            document.createTextNode(AUDIT_LABELS[event.action] ?? event.action),
            el('span', {
              class: `badge badge-${event.outcome}`,
              text: AUDIT_OUTCOME_LABELS[event.outcome] ?? event.outcome,
            }),
            event.detail ? el('div', { class: 'hint', text: event.detail }) : null,
          ].filter(Boolean) as Node[]),
          el('span', { class: 'audit-time', text: formatRelative(event.at, now) }),
        ]),
      );
    }
  }

  body.append(
    el('div', {
      class: 'hint',
      style: 'margin-top:16px',
      text: '审计只记录「做了什么」,绝不记录验证码与种子。最多保留 500 条。',
    }),
  );
  openModal('使用记录', body);
}

// ---------- 弹窗:设置 ----------

function renderSettingsModal() {
  const body = el('div');
  const vault = window.twofa.vault;

  // 同步设置
  const accountInput = el('input', { type: 'text', placeholder: '多设备请填相同名称' });
  const endpointInput = el('input', { type: 'text', placeholder: 'https://2fa.yourdomain.com' });
  const pwInput = el('input', { type: 'password', placeholder: '同步服务登录密码' });
  const alert = el('div', { class: 'alert alert-error' });
  alert.style.display = 'none';

  const connectBtn = el('button', { class: 'btn', text: '开启同步' });
  connectBtn.addEventListener('click', async () => {
    alert.style.display = 'none';
    if (!accountInput.value.trim() || pwInput.value.length < 8) {
      alert.textContent = '请填写账户名,密码至少 8 位';
      alert.style.display = 'block';
      return;
    }
    connectBtn.disabled = true;
    connectBtn.textContent = '连接中…';
    try {
      await window.twofa.connectSync(
        accountInput.value.trim(),
        pwInput.value,
        endpointInput.value.trim() || 'http://localhost:8787',
      );
      pwInput.value = '';
      closeModal();
      toast('同步已开启');
      renderVault();
    } catch (error) {
      alert.textContent = error instanceof Error ? error.message : '连接失败';
      alert.style.display = 'block';
      connectBtn.disabled = false;
      connectBtn.textContent = '开启同步';
    }
  });

  const syncBtn = el('button', { class: 'btn', text: '立即同步' });
  syncBtn.addEventListener('click', async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = '同步中…';
    const result = await vault.sync();
    syncBtn.disabled = false;
    syncBtn.textContent = '立即同步';
    if (result.ok) {
      toast(result.merged > 0 ? `同步完成,合并 ${result.merged} 项` : '同步完成');
      renderVault();
    } else {
      alert.textContent = result.message;
      alert.style.display = 'block';
    }
  });

  const syncBlock = el('div', {}, [
    el('div', { class: 'stat' }, [
      el('span', { class: 'stat-label', text: '同步状态' }),
      el('span', { text: vault.canSync() ? '已开启' : '未开启' }),
    ]),
  ]);
  if (vault.canSync()) {
    syncBlock.append(
      el('div', { class: 'field', style: 'margin-top:16px' }, [el('label', { text: '同步账户' }), accountInput]),
      syncBtn,
    );
  } else {
    syncBlock.append(
      el('div', { class: 'field', style: 'margin-top:16px' }, [el('label', { text: '服务地址' }), endpointInput]),
      el('div', { class: 'field' }, [el('label', { text: '同步账户名' }), accountInput]),
      el('div', { class: 'field' }, [el('label', { text: '登录密码' }), pwInput]),
      el('div', {
        class: 'hint',
        text: '此密码仅用于向同步服务器证明身份,不是主密码,两者可以不同。',
      }),
      connectBtn,
    );
  }

  // 恢复码
  const recoveryBlock = el('div', { style: 'margin-top:24px' }, [
    el('div', { class: 'stat' }, [
      el('span', { class: 'stat-label', text: '剩余恢复码' }),
      el('span', { text: `${vault.remainingRecovery()} / 10` }),
    ]),
  ]);
  const regenBtn = el('button', { class: 'btn-ghost', text: '重新生成恢复码' });
  regenBtn.addEventListener('click', async () => {
    if (!confirm('旧的恢复码会立即全部失效。确定重新生成?')) return;
    const codes = await vault.regenerateRecoveryCodes();
    closeModal();
    renderRecoveryCodes(codes);
  });
  recoveryBlock.append(regenBtn);

  // 锁定
  const lockBtn = el('button', { class: 'btn-ghost', text: '立即锁定' });
  lockBtn.addEventListener('click', async () => {
    await window.twofa.vault.lock();
    closeModal();
    renderGate();
  });

  // 导入导出
  const exportBtn = el('button', { class: 'btn-ghost', text: '导出加密保险库' });
  exportBtn.addEventListener('click', async () => {
    const raw = await vault.exportVault();
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `twofa-vault-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出');
  });

  const wipeBtn = el('button', { class: 'btn-ghost btn-danger', text: '清空本机数据' });
  wipeBtn.addEventListener('click', () => {
    if (!confirm('这会永久删除本机保险库与恢复码。由于主密码不会上传,若无其他副本则无法找回。确定?')) return;
    if (!confirm('最后确认:真的要删除全部数据吗?此操作无法撤销。')) return;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('twofa.web.v1.')) localStorage.removeItem(key);
    }
    location.reload();
  });

  body.append(
    alert,
    el('div', { class: 'section-label', text: '云同步' }),
    syncBlock,
    el('div', { class: 'section-label', text: '安全' }),
    recoveryBlock,
    el('div', { style: 'height:10px' }),
    lockBtn,
    el('div', { class: 'section-label', text: '数据' }),
    exportBtn,
    wipeBtn,
    el('div', {
      class: 'hint',
      style: 'margin-top:20px',
      text: '主密码与种子永不离开本机。忘记主密码后任何人都无法恢复你的账号——这是加密生效的证明。',
    }),
  );

  openModal('设置', body);
}

// ---------- 启动 ----------

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

void bootstrap().then(() => {
  const vault = window.twofa.vault;
  if (vault.isUnlocked()) {
    renderVault();
  } else {
    renderGate();
  }
});
