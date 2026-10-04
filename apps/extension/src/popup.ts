/**
 * 弹窗 UI。
 *
 * 用原生 DOM,与 Web 端同样的理由:界面只有列表加几个表单,
 * 引入框架不划算。
 *
 * 与 Web 端的关键区别在安全边界:
 * 弹窗只是发消息给 service worker,自己不持有任何密钥。
 * 即使某个网站用 CSS 伪装弹窗界面(点击劫持),
 * 它也拿不到种子——真正的解密结果永远在扩展的独立进程里。
 */

declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: {
    query(info: unknown): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

const root = document.getElementById('root')!;

interface Entry {
  id: string;
  issuer: string;
  account: string;
  code: string;
  remaining: number;
}

interface Response<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function send<T>(message: unknown): Promise<Response<T>> {
  return (await chrome.runtime.sendMessage(message)) as Response<T>;
}

type Props = {
  class?: string;
  text?: string;
  type?: string;
  placeholder?: string;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  // 一律 textContent:来自用户输入或导入的文本绝不进 innerHTML
  if (props.text !== undefined) node.textContent = props.text;
  if (props.type && 'type' in node) (node as HTMLInputElement).type = props.type;
  if (props.placeholder) node.setAttribute('placeholder', props.placeholder);
  for (const child of children) node.append(child);
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { class: className, text: label });
  node.addEventListener('click', onClick);
  return node;
}

// ---------- 视图 ----------

function renderLoading(): void {
  root.replaceChildren(el('p', { class: 'hint', text: '加载中…' }));
}

function renderError(message: string): void {
  root.replaceChildren(
    el('p', { class: 'error', text: message }),
    button('重试', 'primary', () => void main()),
  );
}

function renderCreate(): void {
  const password = el('input', { type: 'password', placeholder: '设置主密码' });
  const confirm = el('input', { type: 'password', placeholder: '再输一次' });
  const error = el('p', { class: 'error' });
  const submit = button('创建保险库', 'primary', () => void attempt());

  async function attempt(): Promise<void> {
    error.textContent = '';
    submit.disabled = true;
    const response = await send<{ recoveryCodes: string[] }>({
      type: 'twofa:create',
      password: password.value,
      confirm: confirm.value,
    });
    submit.disabled = false;
    if (!response.ok || !response.data) {
      error.textContent = response.error ?? '创建失败';
      return;
    }
    renderRecovery(response.data.recoveryCodes);
  }

  root.replaceChildren(
    el('p', { class: 'hint', text: '主密码用于加密保险库,不会被上传。忘记后无法找回。' }),
    password,
    confirm,
    error,
    submit,
  );
  password.focus();
}

function renderUnlock(): void {
  const password = el('input', { type: 'password', placeholder: '主密码' });
  const error = el('p', { class: 'error' });

  const attempt = async (): Promise<void> => {
    error.textContent = '';
    if (!password.value) {
      error.textContent = '请输入主密码';
      return;
    }
    const response = await send({ type: 'twofa:unlock', password: password.value });
    if (!response.ok) {
      error.textContent = response.error ?? '解锁失败';
      return;
    }
    void main();
  };

  const submit = button('解锁', 'primary', () => void attempt());
  password.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') void attempt();
  });

  root.replaceChildren(
    el('p', { class: 'hint', text: '5 分钟无操作会自动锁定。' }),
    password,
    error,
    submit,
  );
  password.focus();
}

function renderRecovery(codes: string[]): void {
  root.replaceChildren(
    el('p', { class: 'hint', text: `保存这 ${codes.length} 个恢复码,每个只能用一次。关闭后无法再次查看。` }),
    el('div', { class: 'recovery' }, codes.map((code) => el('code', { text: code }))),
    button('我已保存', 'primary', () => void main()),
  );
}

function renderVault(entries: Entry[]): void {
  const header = el('header', { class: 'header' });
  header.append(
    el('strong', { text: `SecondTally · ${entries.length} 个账号` }),
    button('锁定', 'ghost', () => void send({ type: 'twofa:lock' }).then(() => main())),
  );

  const addBtn = button('添加账号', 'primary', () => renderAddForm(entries));

  if (entries.length === 0) {
    root.replaceChildren(header, el('p', { class: 'hint', text: '还没有账号,点下面按钮添加。' }), addBtn);
    return;
  }

  const list = el('div', { class: 'list' });
  for (const entry of entries) {
    const item = el('div', { class: 'entry' });

    const bar = el('div', { class: 'bar' });
    const fill = el('i');
    fill.style.width = `${Math.max(0, Math.min(1, entry.remaining / 30)) * 100}%`;
    if (entry.remaining <= 5) bar.classList.add('warn');
    bar.append(fill);

    const copyBtn = button('复制', 'ghost', () => {
      void navigator.clipboard.writeText(entry.code).then(() => {
        copyBtn.textContent = '已复制';
        setTimeout(() => {
          copyBtn.textContent = '复制';
        }, 1200);
      });
    });

    const removeBtn = button('删除', 'ghost danger', () => {
      if (!confirm(`删除 ${entry.issuer || entry.account}?`)) return;
      void send({ type: 'twofa:remove', id: entry.id }).then(() => main());
    });

    item.append(
      el('div', { class: 'meta' }, [
        el('strong', { text: entry.issuer || '未命名' }),
        el('span', { class: 'account', text: entry.account }),
      ]),
      el('span', { class: 'code', text: entry.code }),
      bar,
      copyBtn,
      removeBtn,
    );
    list.append(item);
  }

  root.replaceChildren(header, list, addBtn);
}

function renderAddForm(entries: Entry[]): void {
  const issuer = el('input', { placeholder: '服务名,如 GitHub' });
  const account = el('input', { placeholder: '账号,如 alice@example.com' });
  const secret = el('input', { placeholder: 'Base32 种子' });
  const error = el('p', { class: 'error' });

  const submit = button('保存', 'primary', () => void attempt());

  async function attempt(): Promise<void> {
    error.textContent = '';
    submit.disabled = true;
    const response = await send({
      type: 'twofa:addManual',
      issuer: issuer.value.trim(),
      account: account.value.trim(),
      // 去掉用户粘贴时可能带进来的空格与连字符
      secret: secret.value.replace(/[\s-]+/g, ''),
    });
    submit.disabled = false;
    if (!response.ok) {
      error.textContent = response.error ?? '添加失败';
      return;
    }
    void main();
  }

  root.replaceChildren(
    el('p', { class: 'hint', text: '种子是一串 Base32 字符,可在服务网站的 2FA 设置页看到。' }),
    issuer,
    account,
    secret,
    error,
    submit,
    button('返回', 'ghost', () => renderVault(entries)),
  );
  issuer.focus();
}

async function fillCurrentPage(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = tabs[0]?.id;
  if (id === undefined) return;
  try {
    await chrome.tabs.sendMessage(id, { type: 'twofa:page:fill' });
  } catch {
    // chrome:// 等页面不允许注入内容脚本,忽略
  }
}

// ---------- 启动 ----------

async function main(): Promise<void> {
  renderLoading();
  try {
    const has = await send<boolean>({ type: 'twofa:hasVault' });
    if (!has.ok) return renderError(has.error ?? '无法读取保险库状态');
    if (!has.data) return renderCreate();

    const unlocked = await send<boolean>({ type: 'twofa:isUnlocked' });
    if (!unlocked.ok) return renderError(unlocked.error ?? '无法读取解锁状态');
    if (!unlocked.data) return renderUnlock();

    const list = await send<Entry[]>({ type: 'twofa:list' });
    // locked 表示锁定超时等边界情况,回到解锁页而不是报错
    if (!list.ok) return list.error === 'locked' ? renderUnlock() : renderError(list.error ?? '读取失败');
    if (!list.data) return renderUnlock();

    renderVault(list.data);
    // 打开弹窗即自动填一次:用户装扩展的动机就是想少点几下
    await fillCurrentPage();
  } catch (error) {
    renderError(error instanceof Error ? error.message : '未知错误');
  }
}

void main();
