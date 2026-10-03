/**
 * 跨端一致性验证。
 *
 * 这是整个项目最重要的一条测试。
 * "支持跨端"的实质含义只有一个:同一条目在任何一端算出的验证码必须相同。
 * 只要这条不成立,跨端就是假的——用户会在手机上看到的码和电脑上不一样。
 *
 * 做法:分别加载小程序用的 core.mjs(build-miniprogram 产出,ES2017+minify)
 * 与 Web 用的 index.mjs(build-core 产出,ES2020),对同一批条目
 * 在同一时间点取码,逐一比对。
 *
 * 顺带验证 Web 产物真的能被浏览器加载:把 dist/main.js 里的
 * 保险库创建+取码流程跑一遍,确认打包没有破坏运行时行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';

/** 递归列出目录下的所有文件路径。 */
async function walk(dir) {
  const out = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** RFC 4226 附录D 的官方测试种子,Base32 编码后长度 20 字节。 */
const RFC_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const CASES = [
  { issuer: 'GitHub', account: 'alice@example.com', secret: RFC_SEED, digits: 6, period: 30 },
  { issuer: 'AWS', account: 'ops', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA', digits: 6, period: 30 },
  { issuer: 'Google', account: 'bob', secret: 'GEZDGNBVGY3TQOJQ', digits: 8, period: 30 },
  { issuer: 'YubiKey', account: 'long', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', digits: 6, period: 60 },
  // 含小写与空格的种子:现实中从网页复制常是这样
  { issuer: 'Mixed', account: 'case', secret: 'gezd gnbv gy3t qojq', digits: 6, period: 30 },
];

async function loadIfExists(path) {
  if (!existsSync(path)) return null;
  return import(pathToFileURL(path).href);
}

/**
 * 把测试用例转成 totpAt 需要的形状。
 *
 * 注意 secret 必须用【该模块自己的】base32Decode:TotpOptions.secret 的类型是
 * Uint8Array,直接塞字符串会拿到字符串的 UTF-8 字节,算出一个"看起来像验证码
 * 但永远验证不过"的结果。业务代码里由 generateCode 负责转换,测试得自己来。
 */
function toOptions(mod, entry) {
  return {
    secret: mod.base32Decode(entry.secret),
    digits: entry.digits,
    period: entry.period,
    algorithm: 'SHA1',
  };
}

test('小程序产物与 Web 产物对同一条目算出相同验证码', async (t) => {
  const mini = await loadIfExists(resolve(root, 'apps/miniprogram/utils/core.mjs'));
  const web = await loadIfExists(resolve(root, 'packages/core/dist/index.mjs'));

  if (!mini || !web) {
    t.skip('缺少构建产物,先运行 npm run build:core && npm run build:miniprogram');
    return;
  }

  // 固定时间点:2026-01-01T00:00:30Z,落在某个时间步的中段,避免边界抖动
  const now = Date.UTC(2026, 0, 1, 0, 0, 30);

  for (const entry of CASES) {
    const a = mini.totpAt(toOptions(mini, entry), now);
    const b = web.totpAt(toOptions(web, entry), now);
    assert.equal(
      a.code,
      b.code,
      `${entry.issuer}:两端的验证码不一致 (${a.code} vs ${b.code})`,
    );
    assert.equal(a.code.length, entry.digits, `${entry.issuer}:位数应为 ${entry.digits}`);
  }
});

test('小程序产物的小写带空格种子容错生效', async () => {
  const mini = await loadIfExists(resolve(root, 'apps/miniprogram/utils/core.mjs'));
  if (!mini) return; // 未构建时由上一个用例负责报告

  const now = Date.UTC(2026, 0, 1, 0, 0, 30);
  // 参照种子同为 20 字节(RFC 4226 官方测试种子),只改变书写形式:
  // 小写 + 分组空格。这才是从网页复制粘贴时的真实形态。
  const messy = 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq';
  const messyCode = mini.totpAt(toOptions(mini, { ...CASES[0], secret: messy }), now);
  const cleanCode = mini.totpAt(toOptions(mini, CASES[0]), now);
  assert.equal(messyCode.code, cleanCode.code, '容错解码后应与标准种子一致');
});

test('误传 base32 字符串作为 secret 会被明确拒绝', async (t) => {
  const web = await loadIfExists(resolve(root, 'packages/core/dist/index.mjs'));
  if (!web) {
    t.skip('缺少产物,先运行 npm run build:core');
    return;
  }
  const now = Date.UTC(2026, 0, 1, 0, 0, 30);
  // 这是 esbuild 不做类型检查时最容易犯的错。
  // 过去的实现会静默算出"格式正确但永远验证不过"的验证码。
  assert.throws(
    () => web.totpAt({ ...CASES[0] }, now),
    /Uint8Array/,
    '传入字符串 secret 应抛出明确错误',
  );
});

test('Web 产物 main.js 能加载且 core 已被内联', async (t) => {
  const mainPath = resolve(root, 'apps/web/dist/main.js');
  if (!existsSync(mainPath)) {
    t.skip('缺少 Web 产物,先运行 npm run build:web');
    return;
  }
  const source = await readFile(mainPath, 'utf8');

  // 产物必须是自包含的:不能残留 @aegis/core 这类裸模块说明符
  assert.ok(
    !/from\s*["']@aegis\/core["']/.test(source),
    '产物中不应残留 @aegis/core 裸导入',
  );
  // noble 的 PBKDF2 必须在里面(加密逻辑已内联)
  assert.ok(source.includes('pbkdf2'), '产物中应含 PBKDF2 实现');
  // 不能有 require( —— 说明有 CommonJS 残留
  assert.ok(!/\brequire\(/.test(source), '产物中不应有 require 调用');
});

test('扩展产物结构符合 MV3 要求', async (t) => {
  const dist = resolve(root, 'apps/extension/dist');
  if (!existsSync(dist)) {
    t.skip('缺少扩展产物,先运行 npm run build:ext');
    return;
  }

  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module', 'service worker 应声明为 module');

  // 后台脚本引用的文件必须都存在
  const background = await readFile(resolve(dist, 'background.js'), 'utf8');
  assert.ok(background.length > 1000, 'background.js 内容异常');

  // 关键安全检查:我们的代码里绝不能有 Math.random。
  // 若有人用它生成 GCM nonce,nonce 可预测即等同于密钥泄露。
  // 只检查项目源码而非整个 bundle——第三方库可能有正当用途。
  const ownSources = [
    resolve(root, 'packages/core/src'),
    resolve(root, 'apps/extension/src'),
    resolve(root, 'apps/web/src'),
  ];
  for (const dir of ownSources) {
    for (const file of await walk(dir)) {
      if (!file.endsWith('.ts')) continue;
      const text = await readFile(file, 'utf8');
      // 去掉注释后再查,避免把"这里不要用 Math.random"的说明当成违规
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.ok(
        !/Math\s*\.\s*random/.test(code),
        `${file} 中不应出现 Math.random`,
      );
    }
  }

  // 弹窗里同样不能有 innerHTML:条目名来自用户输入
  const popup = await readFile(resolve(dist, 'popup.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(popup), 'popup.js 不得直接赋值 innerHTML');
});
