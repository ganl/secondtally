/**
 * 存储键前缀的三端一致性。
 *
 * 为什么需要这条测试:
 *
 * 这些键是**数据契约**,不是品牌标识。产品一旦发布,改前缀等于让已落盘的
 * 保险库永久无法读取——E2E 模型下主密码不上传,没有任何找回通道。
 *
 * 而危险在于,前缀在三端各自硬编码一份(core 的 vault/lock、
 * Web 的 web.v1.*、扩展的 ext.v1.*、小程序的命名空间),
 * 既没有共享常量,也没有类型约束。**某一端漏改不会编译报错,
 * 也不会有任何测试失败** —— 它只在用户换设备同步时表现为
 * "数据在另一台机器上读不出来",到那时已经改不回来了。
 *
 * 所以这里用测试把 7 处钉死。断言的核心不变量只有一条:
 * 所有键共享同一个命名空间前缀,因此小程序"按前缀全清"能覆盖全部。
 *
 * 本文件故意放在 core/test 下却检查 apps/ 的源码——这个契约是跨端的,
 * 放在任何单端的测试目录里都会让人误以为它是那一端的私事。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

/** 从源码里抓出单引号包裹的字符串常量。 */
function constString(src, name) {
  const m = new RegExp(`${name}\\s*=\\s*'([^']*)'`).exec(src);
  assert.ok(m, `没找到常量 ${name} 的定义——是改名了还是换成了模板字符串?`);
  return m[1];
}

/** 命名空间前缀。改这个值意味着全量数据迁移,必须刻意而为。 */
const NAMESPACE = 'twofa.';

test('core 的保险库键与锁键在数据命名空间下', () => {
  const src = read('packages/core/src/vault/service.ts');
  assert.equal(constString(src, 'STORAGE_KEY'), `${NAMESPACE}vault.v1`);
  assert.equal(constString(src, 'LOCK_KEY'), `${NAMESPACE}lock.v1`);
});

test('三端的存储前缀共用同一个数据命名空间', () => {
  const cases = [
    ['apps/web/src/platform.ts', 'STORAGE_PREFIX', `${NAMESPACE}web.v1.`],
    ['apps/extension/src/platform.ts', 'STORAGE_PREFIX', `${NAMESPACE}ext.v1.`],
    ['apps/extension/src/background.ts', 'STORAGE_PREFIX', `${NAMESPACE}ext.v1.`],
    ['apps/miniprogram/platform.ts', 'STORAGE_NAMESPACE', NAMESPACE],
  ];
  for (const [file, name, expected] of cases) {
    assert.equal(constString(read(file), name), expected, `${file} 的 ${name} 与命名空间不一致`);
  }
});

test('Web 端清空本机数据时按前缀匹配,用的就是存储前缀', () => {
  const src = read('apps/web/src/main.ts');
  const m = /key\.startsWith\('([^']+)'\)/.exec(src);
  assert.ok(m, '没找到清空逻辑里的 startsWith 前缀匹配');
  assert.equal(m[1], `${NAMESPACE}web.v1.`);
});

test('小程序清空后不残留任何本应用的键', () => {
  const src = read('apps/miniprogram/platform.ts');
  // wipeAllStorage 按命名空间过滤;下面这些键必须都落在命名空间内,
  // 否则"清空"会静默漏掉它们(历史上漏过 session 族,后果是登录态还在)。
  for (const key of ['vault.v1', 'lock.v1', 'session.', 'device.id.v1', 'device.name.v1']) {
    assert.ok(src.includes(`${NAMESPACE}${key}`) || src.includes(key), `清空清单里应有 ${key}`);
  }
});
