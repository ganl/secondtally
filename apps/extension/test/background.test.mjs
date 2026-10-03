/**
 * 扩展后台逻辑的离线验证。
 *
 * 目的:esbuild 只做打包不做类型检查,popup/content 的类型错误要到浏览器里
 * 才暴露。这里用最小 chrome API 桩件驱动打包后的 background.js,
 * 在Node 里跑通"创建 -> 锁定 -> 解锁 -> 生成验证码 -> 手动添加 -> 删除"全流程。
 *
 * chrome.storage 桩件用Map 模拟,行为与真实 local 区的差别只在持久化,
 * 而持久化不影响加密正确性。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildSync } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = resolve(root, 'apps/extension/src/background.ts');
// 每次调用分配独立目录:同文件内各用例并发执行,共用目录会互相删产物。
let sequence = 0;
function scratchDir() {
  sequence += 1;
  return resolve(root, '.tmp', `ext-test-${process.pid}-${sequence}`);
}

async function loadBackground() {
  const tmp = scratchDir();
  await mkdir(tmp, { recursive: true });
  const outfile = resolve(tmp, 'background.mjs');
  // 用 buildSync 而非 build():同步版自己负责启动并回收 esbuild 子进程,
  // 不会留下常驻句柄让测试文件挂到超时。测试不需要并行,不需要异步构建。
  buildSync({
    entryPoints: [src],
    bundle: true,
    format: 'esm',
    target: ['node20'],
    platform: 'browser',
    outfile,
    logLevel: 'silent',
    alias: { '@aegis/core': resolve(root, 'packages/core/src/index.ts') },
  });

  const store = new Map();
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null) return Object.fromEntries(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) store.set(k, v);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        },
      },
    },
    runtime: {
      onMessage: { addListener: (cb) => listeners.push(cb) },
      onInstalled: { addListener: () => {} },
      getURL: (p) => `chrome-extension://test/${p}`,
    },
  };

  globalThis.chrome = chrome;
  globalThis.crypto ??= (await import('node:crypto')).webcrypto;
  // Windows 上绝对路径不能直接传给 import(),必须转成 file:// URL
  const mod = await import(`${pathToFileURL(outfile).href}?v=${Date.now()}`);
  return { mod, store, listeners, chrome };
}

/** 模拟一次 sendMessage 往返。 */
function makeCall(listeners) {
  return (message) =>
    new Promise((resolve, reject) => {
      const kept = listeners[0](message, {}, resolve);
      if (kept !== true) reject(new Error('listener did not keep channel open'));
    });
}

/**
 * 起一个后台实例,并在测试结束后确保锁定。
 *
 * 为什么必须锁定:VaultService 用 setTimeout 实现"5 分钟无操作自动锁定",
 * 这个定时器会一直占着事件循环。不清掉的话,所有断言都通过,
 * 但测试文件会挂到超时才被判定失败。lock() 内部会 clearTimeout。
 */
async function fixture(t) {
  const { listeners } = await loadBackground();
  assert.equal(listeners.length, 1, '应注册恰好一个 onMessage 监听器');
  const call = makeCall(listeners);
  t.after(async () => {
    await call({ type: 'aegis:lock' });
  });
  return call;
}

// background.ts 在模块顶层就读 globalThis.chrome,所以桩件必须挂在全局。
// 全局是进程唯一的:两个实例并发会互相覆盖对方的存储。
// 因此所有用例共用一把异步锁,强制串行执行。
let chain = Promise.resolve();
function exclusive(fn) {
  return async (...args) => {
    const previous = chain;
    let release;
    chain = new Promise((r) => (release = r));
    await previous;
    try {
      return await fn(...args);
    } finally {
      release();
    }
  };
}

test('扩展后台:创建->锁定->解锁->验证码全流程', exclusive(async (t) => {
  const call = await fixture(t);

  // 初始:没有保险库
  assert.deepEqual(await call({ type: 'aegis:hasVault' }), { ok: true, data: false });

  // 创建
  const created = await call({ type: 'aegis:create', password: 'corr3ct-horse-battery', confirm: 'corr3ct-horse-battery' });
  assert.equal(created.ok, true, created.error);
  const codes = created.data.recoveryCodes;
  assert.equal(codes.length, 10, '恢复码应为10 条');
  assert.ok(codes.every((c) => typeof c === 'string' && c.length > 0));

  // 创建后应立即处于解锁态
  assert.deepEqual(await call({ type: 'aegis:isUnlocked' }), { ok: true, data: true });

  // 手动添加一个账号。RFC 4226 种子
  const added = await call({
    type: 'aegis:addManual',
    issuer: 'GitHub',
    account: 'alice@example.com',
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  assert.equal(added.ok, true, added.error);
  const entryId = added.data.id;

  // 列出的验证码应为 6 位数字
  const listed = await call({ type: 'aegis:list' });
  assert.equal(listed.ok, true);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.data[0].issuer, 'GitHub');
  assert.match(listed.data[0].code, /^\d{6}$/);

  // 锁定后所有敏感操作必须失败
  assert.deepEqual(await call({ type: 'aegis:lock' }), { ok: true });
  assert.deepEqual(await call({ type: 'aegis:isUnlocked' }), { ok: true, data: false });

  for (const message of [
    { type: 'aegis:list' },
    { type: 'aegis:fillAll' },
    { type: 'aegis:codeFor', host: 'github.com' },
    { type: 'aegis:remove', id: entryId },
  ]) {
    const response = await call(message);
    assert.deepEqual(response, { ok: false, error: 'locked' }, `${message.type} 在锁定时必须被拒绝`);
  }

  // 错误密码不能解锁
  const wrong = await call({ type: 'aegis:unlock', password: 'wrong-password-entirely' });
  assert.equal(wrong.ok, false);
  assert.deepEqual(await call({ type: 'aegis:isUnlocked' }), { ok: true, data: false });

  // 正确密码解锁后,数据应当还在,且验证码与锁定前一致
  const unlocked = await call({ type: 'aegis:unlock', password: 'corr3ct-horse-battery' });
  assert.equal(unlocked.ok, true, unlocked.error);
  const relisted = await call({ type: 'aegis:list' });
  assert.equal(relisted.data.length, 1);
  assert.equal(relisted.data[0].id, entryId, '解锁后条目 id 应保持一致');
  assert.equal(relisted.data[0].code, listed.data[0].code, '同一时间步内验证码应相同');
}));

test('扩展后台:按域名匹配验证码,且子域不误匹配', exclusive(async (t) => {
  const call = await fixture(t);
  await call({ type: 'aegis:create', password: 'another-strong-passphrase', confirm: 'another-strong-passphrase' });
  await call({ type: 'aegis:addManual', issuer: 'github.com', account: 'a', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' });

  // 精确匹配
  const exact = await call({ type: 'aegis:codeFor', host: 'github.com' });
  assert.equal(exact.ok, true);
  assert.ok(exact.data, 'github.com 应匹配到条目');
  assert.match(exact.data.code, /^\d{6}$/);

  // 子域也应匹配(登录可能走 gist.github.com 之类)
  const sub = await call({ type: 'aegis:codeFor', host: 'gist.github.com' });
  assert.ok(sub.data, '子域应匹配');

  // 前缀相同但不同域不应误匹配
  const spoof = await call({ type: 'aegis:codeFor', host: 'notgithub.com' });
  assert.equal(spoof.data, null, 'notgithub.com 不应命中 github.com');

  // 无关域名返回 null
  const other = await call({ type: 'aegis:codeFor', host: 'example.org' });
  assert.equal(other.data, null);
}));

test('扩展后台:未知请求被拒绝', exclusive(async (t) => {
  const call = await fixture(t);
  const response = await call({ type: 'aegis:does-not-exist' });
  assert.equal(response.ok, false);
}));

test('扩展后台:非法种子被拒绝且不写入条目', exclusive(async (t) => {
  const call = await fixture(t);
  await call({ type: 'aegis:create', password: 'third-strong-passphrase', confirm: 'third-strong-passphrase' });

  // 含非法字符的 Base32
  const bad = await call({
    type: 'aegis:addManual',
    issuer: 'Bad',
    account: 'x',
    secret: 'GEZDGNBVGY3TQOJQ1908!',
  });
  assert.equal(bad.ok, false, '非法 Base32 必须被拒绝');

  // 拒绝后不能留下半成品条目
  const listed = await call({ type: 'aegis:list' });
  assert.equal(listed.data.length, 0, '失败的添加不应留下条目');
}));
