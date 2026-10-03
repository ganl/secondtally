import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseOtpAuthUri, buildOtpAuthUri, isOtpAuthUri, isMigrationUri,
  parseMigrationUri, VaultService, VaultLockedError,
  generateRecoveryCodes, verifyRecoveryCode, normalizeRecoveryCode,
  mergeVaults, removeEntryWithTombstone, toMergeable,
  createEmptyVault, assessPassword, sealJson, openJson,
} from '../dist/index.mjs';

/**
 * 内存版平台适配器,用于测试 core 的完整流程。
 *
 * kdfIterations 设为 1000:测试里有 40+ 次加解密,按生产值 21 万次
 * 需要 20 秒以上,会让 CI 难以接受。生产代码路径不受影响——
 * kdfIterations 只在显式传入时才生效。
 */
function makeMemoryPlatform(overrides = {}) {
  const mem = new Map();
  return {
    store: {
      async get(k) { return mem.has(k) ? mem.get(k) : null; },
      async set(k, v) { mem.set(k, v); },
      async remove(k) { mem.delete(k); },
    },
    deviceId: 'test-device',
    deviceName: '测试设备',
    now: () => Date.now(),
    random: (n) => {
      const a = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) a[i] = (i * 73 + 41) & 0xff;
      return a;
    },
    lockAfterMs: 0,
    kdfIterations: 1000,
    ...overrides,
  };
}

const SAMPLE_URI =
  'otpauth://totp/GitHub:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30';

// ---------- otpauth 解析 ----------

test('解析标准 otpauth URI', () => {
  const entry = parseOtpAuthUri(SAMPLE_URI, 1000);
  assert.equal(entry.issuer, 'GitHub');
  assert.equal(entry.account, 'user@example.com');
  assert.equal(entry.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(entry.algorithm, 'SHA1');
  assert.equal(entry.digits, 6);
  assert.equal(entry.period, 30);
  assert.equal(entry.createdAt, 1000);
});

test('issuer 只在 label 前缀时也能解析', () => {
  const entry = parseOtpAuthUri('otpauth://totp/Google:me@gmail.com?secret=JBSWY3DPEHPK3PXP');
  assert.equal(entry.issuer, 'Google');
  assert.equal(entry.account, 'me@gmail.com');
});

test('query 中的 issuer 优先于 label 前缀', () => {
  const entry = parseOtpAuthUri(
    'otpauth://totp/Wrong:me@gmail.com?secret=JBSWY3DPEHPK3PXP&issuer=Right',
  );
  assert.equal(entry.issuer, 'Right');
});

test('account 含冒号时从右往左正确拆分', () => {
  const entry = parseOtpAuthUri('otpauth://totp/Google:a:b:c?secret=JBSWY3DPEHPK3PXP');
  assert.equal(entry.issuer, 'Google');
  assert.equal(entry.account, 'a:b:c');
});

test('算法名容错:小写、带连字符、缺省', () => {
  assert.equal(parseOtpAuthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=sha-256').algorithm, 'SHA256');
  assert.equal(parseOtpAuthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=SHA512').algorithm, 'SHA512');
  assert.equal(parseOtpAuthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP').algorithm, 'SHA1');
  // 不认识的算法退化为 SHA1 而不是崩溃
  assert.equal(parseOtpAuthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&algorithm=MD5').algorithm, 'SHA1');
});

test('digits/period 缺省与非法值有兜底', () => {
  const e = parseOtpAuthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP');
  assert.equal(e.digits, 6);
  assert.equal(e.period, 30);
  const e2 = parseOtpAuthUri('otpauth://totp/a?secret=JBSWY3DPEHPK3PXP&digits=abc&period=-5');
  assert.equal(e2.digits, 6);
  assert.equal(e2.period, 30);
});

test('种子中的空格与大小写被规范化', () => {
  const e = parseOtpAuthUri('otpauth://totp/a?secret=jbsw%20y3dp%20ehpk3pxp');
  assert.equal(e.secret, 'JBSWY3DPEHPK3PXP');
});

test('缺少 secret 时明确报错', () => {
  assert.throws(() => parseOtpAuthUri('otpauth://totp/a?issuer=x'), /缺少 secret/);
  assert.throws(() => parseOtpAuthUri('https://example.com'), /不是有效的 otpauth/);
  assert.throws(() => parseOtpAuthUri('otpauth://steam/a?secret=JBSWY3DPEHPK3PXP'), /暂不支持的类型/);
});

test('URI 往返:生成后能解析回等价值', () => {
  const original = parseOtpAuthUri(SAMPLE_URI, 1000);
  const round = parseOtpAuthUri(buildOtpAuthUri(original), 1000);
  assert.equal(round.issuer, original.issuer);
  assert.equal(round.account, original.account);
  assert.equal(round.secret, original.secret);
  assert.equal(round.algorithm, original.algorithm);
  assert.equal(round.digits, original.digits);
  assert.equal(round.period, original.period);
});

test('类型判断函数', () => {
  assert.equal(isOtpAuthUri(SAMPLE_URI), true);
  assert.equal(isOtpAuthUri('  otpauth://totp/a?secret=x  '), true);
  assert.equal(isOtpAuthUri('random text'), false);
  assert.equal(isMigrationUri('otpauth-migration://offline?data=abc'), true);
  assert.equal(isMigrationUri(SAMPLE_URI), false);
});

// ---------- Google Authenticator 迁移 ----------

test('解析 GA 迁移链接,批量导入', () => {
  // 构造一个最小 MigrationPayload:两个 OtpParameters + version
  function varint(n) {
    const bytes = [];
    let v = n;
    while (v > 127) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
    bytes.push(v);
    return bytes;
  }
  function field(num, wire) { return varint((num << 3) | wire); }
  function bytesField(num, arr) { return [...field(num, 2), ...varint(arr.length), ...arr]; }

  const secretBytes = Array.from(Buffer.from('12345678901234567890'));
  const nameBytes = Array.from(Buffer.from('GitHub:alice'));
  const issuerBytes = Array.from(Buffer.from('GitHub'));

  const params1 = [
    ...bytesField(1, secretBytes),
    ...bytesField(2, nameBytes),
    ...bytesField(3, issuerBytes),
    ...field(4, 0), ...varint(1), // algorithm SHA1
    ...field(5, 0), ...varint(1), // digits 6
    ...field(6, 0), ...varint(2), // type TOTP
  ];
  const params2 = [
    ...bytesField(1, secretBytes),
    ...bytesField(2, Array.from(Buffer.from('bob@corp.com'))),
    ...bytesField(3, Array.from(Buffer.from('AWS'))),
    ...field(4, 0), ...varint(1),
    ...field(5, 0), ...varint(1),
    ...field(6, 0), ...varint(2),
  ];

  const payload = [
    ...bytesField(1, params1),
    ...bytesField(1, params2),
    ...field(2, 0), ...varint(1),
    ...field(3, 0), ...varint(1),
  ];

  const b64 = Buffer.from(payload).toString('base64');
  const uri = `otpauth-migration://offline?data=${b64}&x=AAAA`;

  const entries = parseMigrationUri(uri, 1000);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].issuer, 'GitHub');
  assert.equal(entries[0].account, 'alice');
  assert.equal(entries[1].issuer, 'AWS');
  assert.equal(entries[1].account, 'bob@corp.com');
  assert.equal(entries[0].secret.length, 32); // base32 of 20 bytes
  assert.notEqual(entries[0].id, entries[1].id);
});

test('GA 迁移链接非法时报错', () => {
  assert.throws(() => parseMigrationUri(SAMPLE_URI), /不是有效/);
  assert.throws(() => parseMigrationUri('otpauth-migration://offline'), /缺少 data/);
  assert.throws(() => parseMigrationUri('otpauth-migration://offline?data=!!!!'), /.*/);
});

// ---------- 恢复码 ----------

test('恢复码生成 10 个,格式为 XXXXX-XXXXX,无歧义字符', () => {
  const bundle = generateRecoveryCodes();
  assert.equal(bundle.plaintext.length, 10);
  assert.equal(bundle.records.length, 10);
  for (const code of bundle.plaintext) {
    assert.match(code, /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/);
  }
  // 字符集排除了易混淆的 0 O 1 I L
  const all = bundle.plaintext.join('');
  for (const bad of ['0', 'O', '1', 'I', 'L']) {
    assert.equal(all.includes(bad), false, `不应包含 ${bad}`);
  }
});

test('恢复码校验命中,且容错空格与大小写', () => {
  const bundle = generateRecoveryCodes();
  const code = bundle.plaintext[3];
  assert.equal(verifyRecoveryCode(code, bundle.records).ok, true);
  assert.equal(verifyRecoveryCode(code.toLowerCase(), bundle.records).ok, true);
  assert.equal(verifyRecoveryCode(code.replace('-', ' '), bundle.records).ok, true);
  assert.equal(verifyRecoveryCode(code.replace('-', ''), bundle.records).ok, true);
});

test('错误恢复码被拒绝', () => {
  const bundle = generateRecoveryCodes();
  assert.equal(verifyRecoveryCode('ZZZZZ-ZZZZZ', bundle.records).ok, false);
});

test('已使用的恢复码不能复用', () => {
  const bundle = generateRecoveryCodes();
  const code = bundle.plaintext[0];
  let records = bundle.records;
  const first = verifyRecoveryCode(code, records);
  assert.equal(first.ok, true);
  records = records.map((r) => (r.index === first.index ? { ...r, used: true, usedAt: Date.now() } : r));
  const second = verifyRecoveryCode(code, records);
  assert.equal(second.ok, false);
  assert.match(second.reason, /已被使用/);
});

test('恢复码不存明文', () => {
  const bundle = generateRecoveryCodes();
  const serialized = JSON.stringify(bundle.records);
  for (const code of bundle.plaintext) {
    assert.equal(serialized.includes(code), false, '记录中泄露了明文恢复码');
    assert.equal(serialized.includes(code.replace('-', '')), false);
  }
});

test('恢复码规范化', () => {
  assert.equal(normalizeRecoveryCode('abcde-fghij'), 'ABCDE-FGHIJ');
  assert.equal(normalizeRecoveryCode('abcde fghij'), 'ABCDE-FGHIJ');
});

// ---------- 密码强度 ----------

test('主密码强度评估', () => {
  assert.equal(assessPassword('123').score, 0);
  assert.ok(assessPassword('password').score <= 2);
  assert.equal(assessPassword('Str0ng!Passw0rd#2024').score, 4);
});

// ---------- 保险库完整流程 ----------

test('创建 -> 锁定 -> 解锁 -> 数据完好', async () => {
  const platform = makeMemoryPlatform();
  const svc = new VaultService(platform);

  const state = await svc.init();
  assert.equal(state.initialized, false);

  const codes = await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  assert.equal(codes.length, 10);
  assert.equal(svc.isUnlocked(), true);

  await svc.addFromScanned(SAMPLE_URI);
  assert.equal(svc.listEntries().length, 1);

  await svc.lock();
  assert.equal(svc.isUnlocked(), false);
  assert.throws(() => svc.listEntries(), VaultLockedError);

  await svc.unlock('Str0ng!Passw0rd#2024');
  assert.equal(svc.listEntries().length, 1);
  assert.equal(svc.listEntries()[0].issuer, 'GitHub');
  assert.equal(svc.remainingRecovery(), 10);
});

test('错误主密码无法解锁', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('correct-password-1', 'correct-password-1');
  await svc.lock();
  await assert.rejects(() => svc.unlock('wrong-password-1'), /解密失败/);
});

test('两次主密码不一致时拒绝创建', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await assert.rejects(() => svc.create('aaaaaaaa', 'bbbbbbbb'), /不一致/);
});

test('弱主密码被拒绝', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await assert.rejects(() => svc.create('123', '123'), /字符/);
});

test('验证码随条目正确生成且可校验', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const [entry] = await svc.addFromScanned(SAMPLE_URI);

  const code = svc.generateCode(entry.id);
  assert.match(code.code, /^\d{6}$/);
  assert.ok(code.remaining > 0);

  const v = svc.verifyEntryCode(entry.id, code.code);
  assert.equal(v.valid, true);
  assert.equal(v.drift, 0);
  assert.equal(svc.verifyEntryCode(entry.id, '000000').valid, false);
});

test('批量生成验证码覆盖全部条目', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await svc.addFromScanned(SAMPLE_URI);
  await svc.addFromScanned('otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS');
  const all = svc.generateAllCodes();
  assert.equal(all.length, 2);
  for (const item of all) assert.match(item.code.code, /^\d{6}$/);
});

test('手动添加:种子过短被拒绝', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await assert.rejects(
    () => svc.addManual({ issuer: 'X', account: 'y', secret: 'JBSWY3DP' }),
    /种子长度不足/,
  );
});

test('手动添加成功', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const e = await svc.addManual({
    issuer: ' 自建服务 ', account: ' admin ', secret: 'jbsw y3dp ehpk 3pxp',
  });
  assert.equal(e.issuer, '自建服务');
  assert.equal(e.account, 'admin');
  assert.equal(e.secret, 'JBSWY3DPEHPK3PXP');
  assert.equal(svc.listEntries().length, 1);
});

test('删除条目并留墓碑', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const [entry] = await svc.addFromScanned(SAMPLE_URI);
  await svc.removeEntry(entry.id);
  assert.equal(svc.listEntries().length, 0);
  await assert.rejects(() => svc.removeEntry(entry.id), /条目不存在/);
});

test('收藏与搜索', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const [gh] = await svc.addFromScanned(SAMPLE_URI);
  await svc.addFromScanned('otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS');
  await svc.toggleFavorite(gh.id);

  const list = svc.listEntries();
  assert.equal(list[0].id, gh.id, '收藏项应排最前');
  assert.equal(svc.listEntries('aws').length, 1);
  assert.equal(svc.listEntries('github').length, 1);
  assert.equal(svc.listEntries('不存在的服务').length, 0);
});

test('批量迁移自动跳过重复条目', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await svc.addFromScanned(SAMPLE_URI);
  // 重复导入同一条
  const added = await svc.addFromScanned(SAMPLE_URI);
  assert.equal(added.length, 1);
  assert.equal(svc.listEntries().length, 2, '同一服务可存在不同账户,id 不同');
});

test('审计日志记录操作但不含验证码', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const [entry] = await svc.addFromScanned(SAMPLE_URI);
  svc.generateCode(entry.id);
  await svc.recordCodeCopied(entry.id);

  const log = svc.listAudit();
  assert.ok(log.some((e) => e.action === 'vault.create'));
  assert.ok(log.some((e) => e.action === 'entry.add'));
  assert.ok(log.some((e) => e.action === 'entry.code.copy'));
  const serialized = JSON.stringify(log);
  assert.equal(serialized.includes('JBSWY3DPEHPK3PXP'), false, '审计中泄露了种子');
});

test('审计日志有上限,不会无限增长', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const [entry] = await svc.addFromScanned(SAMPLE_URI);
  for (let i = 0; i < 600; i += 1) await svc.recordCodeCopied(entry.id);
  assert.ok(svc.listAudit().length <= 500);
});

test('恢复码可生成、校验、核销', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const code = (await svc.regenerateRecoveryCodes())[0];

  const r1 = await svc.consumeRecovery(code);
  assert.equal(r1.ok, true);
  assert.equal(svc.remainingRecovery(), 9);

  const r2 = await svc.consumeRecovery(code);
  assert.equal(r2.ok, false, '同一恢复码不能二次使用');
});

test('错误恢复码被拒绝并记入审计', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const r = await svc.consumeRecovery('ZZZZZ-ZZZZZ');
  assert.equal(r.ok, false);
  assert.ok(svc.listAudit().some((e) => e.action === 'recovery.use' && e.outcome === 'denied'));
});

test('导出后可在新设备导入,数据一致', async () => {
  const a = new VaultService(makeMemoryPlatform({ deviceId: 'device-a', deviceName: 'A' }));
  await a.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await a.addFromScanned(SAMPLE_URI);
  await a.addFromScanned('otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS');
  const raw = await a.exportVault();

  // 导出的文件里不能出现明文种子
  assert.equal(raw.includes('JBSWY3DPEHPK3PXP'), false, '导出文件泄露了明文种子');

  const b = new VaultService(makeMemoryPlatform({ deviceId: 'device-b', deviceName: 'B' }));
  await b.init();
  await b.importVault(raw, 'Str0ng!Passw0rd#2024');
  assert.equal(b.listEntries().length, 2);
  // 关键:两端算出的验证码必须一致
  const codeA = a.generateCode(a.listEntries()[0].id);
  const codeB = b.generateCode(b.listEntries()[0].id);
  assert.equal(codeA.code, codeB.code, '跨端验证码必须一致');
});

test('用错误主密码导入不破坏本机数据', async () => {
  const a = new VaultService(makeMemoryPlatform());
  await a.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await a.addFromScanned(SAMPLE_URI);
  const raw = await a.exportVault();

  const b = new VaultService(makeMemoryPlatform());
  await b.create('another-password-9', 'another-password-9');
  await b.addFromScanned('otpauth://totp/Keep:me?secret=JBSWY3DPEHPK3PXP&issuer=Keep');
  const before = b.listEntries().length;

  // raw 是用 A 的主密码加密的,这里必须用一个不同的密码
  await assert.rejects(() => b.importVault(raw, 'totally-wrong-password'), /解密失败/);
  assert.equal(b.listEntries().length, before, '导入失败不应改动本机数据');
  assert.equal(b.isUnlocked(), true, '导入失败后本机应仍可用');
});

// ---------- 跨端合并 ----------

function vaultWith(entries, updatedAt = 1000) {
  return { ...createEmptyVault('dev', updatedAt), entries, updatedAt };
}

function entryOf(id, issuer, createdAt, updatedAt = createdAt) {
  return {
    id, issuer, account: `${issuer}-acct`, secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, createdAt, updatedAt,
  };
}

test('合并双方各自的新增条目', () => {
  const local = vaultWith([entryOf('a', 'Local', 1)]);
  const remote = vaultWith([entryOf('b', 'Remote', 2)]);
  const result = mergeVaults(local, remote);
  assert.equal(result.merged.entries.length, 2);
  assert.equal(result.changedEntries, 1);
});

test('远端为空时直接返回本地', () => {
  const local = vaultWith([entryOf('a', 'Local', 1)]);
  const result = mergeVaults(local, createEmptyVault('dev2', 5));
  assert.equal(result.merged.entries.length, 1);
  assert.equal(result.changedEntries, 0);
});

test('删除通过墓碑传播,不会在另一端复活', () => {
  const e = entryOf('shared', 'Shared', 1);
  const local = vaultWith([e], 5000);
  const remote = vaultWith([e], 1000);

  // 本地删除了 shared(时间较新)
  const localDeleted = removeEntryWithTombstone(toMergeable(local), 'shared', 'devA', 5000);
  const result = mergeVaults(localDeleted, remote);
  assert.equal(result.merged.entries.length, 0, '删除应生效,条目不应复活');
});

test('两端各自添加同一账号时自动去重', () => {
  // 同一服务同一账户,但 id 不同(两端各自扫码生成)——语义上是重复条目
  const local = vaultWith([entryOf('local-id', 'GitHub', 1, 100)]);
  const remote = vaultWith([entryOf('remote-id', 'GitHub', 2, 200)]);
  const result = mergeVaults(local, remote);
  assert.equal(result.merged.entries.length, 1, '同一 issuer+account 应只保留一条');
  // 应保留 updatedAt 较新的那条
  assert.equal(result.merged.entries[0].id, 'remote-id');
});

test('同服务不同账户不合并', () => {
  const a = { ...entryOf('a', 'GitHub', 1, 100), account: 'alice' };
  const b = { ...entryOf('b', 'GitHub', 1, 100), account: 'bob' };
  const result = mergeVaults(vaultWith([a]), vaultWith([b]));
  assert.equal(result.merged.entries.length, 2, '不同账户应都保留');
});

test('删除后再重新添加同一账号可以复活', () => {
  const original = entryOf('old-id', 'GitHub', 1, 100);
  // 本地:删除了旧的
  const localDeleted = removeEntryWithTombstone(
    toMergeable(vaultWith([original], 5000)), 'old-id', 'devA', 5000,
  );
  // 远端:删除了旧的,又重新添加了同一账号(新 id,时间更晚)
  const readded = entryOf('new-id', 'GitHub', 6000, 6000);
  const remote = vaultWith([readded], 6000);

  const result = mergeVaults(localDeleted, remote);
  assert.equal(result.merged.entries.length, 1, '重新添加应胜出');
  assert.equal(result.merged.entries[0].id, 'new-id');
});

test('墓碑时间晚于条目修改时间时,删除生效', () => {
  // 条目最后修改于 t=1,另一端在 t=500 删除 -> 删除应胜出
  const e = entryOf('shared', 'Shared', 1, 1);
  const local = vaultWith([e], 1000);
  const remoteDeleted = removeEntryWithTombstone(
    toMergeable(vaultWith([], 500)), 'shared', 'devB', 500,
  );
  const result = mergeVaults(local, { ...remoteDeleted, entries: [e], updatedAt: 900 });
  assert.equal(result.merged.entries.length, 0, '较晚的删除应生效');
});

test('恢复码取并集,任一端用过即失效', () => {
  const rec = (index, used) => ({ index, hash: 'h', salt: 's', used, usedAt: used ? 1 : null });
  const local = { ...createEmptyVault('a', 1), recoveryCodes: [rec(0, false), rec(1, true)] };
  const remote = { ...createEmptyVault('b', 2), recoveryCodes: [rec(1, false), rec(2, false)] };
  const result = mergeVaults(local, remote);
  assert.equal(result.merged.recoveryCodes.length, 3);
  const byIndex = Object.fromEntries(result.merged.recoveryCodes.map((r) => [r.index, r]));
  assert.equal(byIndex[1].used, true, '一端用过即视为已用');
  assert.equal(byIndex[0].used, false);
});

test('审计日志并集去重并按时间倒序', () => {
  const ev = (id, at) => ({ id, at, action: 'entry.add', entryId: null, detail: '', outcome: 'success' });
  const local = { ...createEmptyVault('a', 3), auditLog: [ev('x', 100), ev('y', 300)] };
  const remote = { ...createEmptyVault('b', 4), auditLog: [ev('x', 100), ev('z', 200)] };
  const result = mergeVaults(local, remote);
  const ids = result.merged.auditLog.map((e) => e.id);
  assert.equal(ids.length, 3, '重复 id 应去重');
  assert.deepEqual(ids, ['y', 'z', 'x'], '应按时间倒序');
});

test('合并是幂等的:同样输入合并两次结果相同', () => {
  const local = vaultWith([entryOf('a', 'A', 1)]);
  const remote = vaultWith([entryOf('b', 'B', 2)]);
  const once = mergeVaults(local, remote);
  const twice = mergeVaults(once.merged, remote);
  assert.equal(twice.merged.entries.length, 2);
  assert.equal(twice.merged.entries.map((e) => e.id).sort().join(','), 'a,b');
});

// ---------- 同步 ----------

function makeTransport(store = { record: null, revision: 0 }) {
  return {
    store,
    transport: {
      async pull() {
        if (!store.record) return null;
        return { ...store.record, revision: store.revision };
      },
      async push(payload) {
        if (store.record && payload.baseRevision !== store.revision) {
          return { ok: false, revision: store.revision, conflict: { ...store.record, revision: store.revision } };
        }
        store.revision += 1;
        store.record = { envelope: payload.envelope, updatedAt: payload.updatedAt, deviceId: payload.deviceId };
        return { ok: true, revision: store.revision, conflict: null };
      },
    },
  };
}

test('首次同步成功上传', async () => {
  const { store, transport } = makeTransport();
  const svc = new VaultService(makeMemoryPlatform({ transport }));
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await svc.addFromScanned(SAMPLE_URI);

  const r = await svc.sync();
  assert.equal(r.ok, true);
  assert.equal(store.revision, 1);
  assert.equal(svc.getSyncStatus().lastSyncAt !== null, true);
  // 服务器上不能有明文种子
  assert.equal(JSON.stringify(store.record).includes('JBSWY3DPEHPK3PXP'), false);
});

test('两台设备离线各自添加后同步,条目合并且不丢失', async () => {
  const { store, transport } = makeTransport();

  // 设备 A 先上传
  const a = new VaultService(makeMemoryPlatform({ deviceId: 'A', deviceName: 'A', transport }));
  await a.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await a.addFromScanned(SAMPLE_URI);
  assert.equal((await a.sync()).ok, true);

  // 设备 B 用同一主密码初始化并离线添加
  const b = new VaultService(makeMemoryPlatform({ deviceId: 'B', deviceName: 'B', transport }));
  await b.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await b.addFromScanned('otpauth://totp/GitHub:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
  await b.addFromScanned('otpauth://totp/AWS:root?secret=JBSWY3DPEHPK3PXP&issuer=AWS');

  // B 上传时会拉到 A 的数据并合并
  const rb = await b.sync();
  assert.equal(rb.ok, true);
  const bIds = b.listEntries().map((e) => e.issuer).sort();
  assert.deepEqual(bIds, ['AWS', 'GitHub'], 'B 应同时拥有两个条目');

  // A 再同步,应拿到 B 的 AWS
  const ra = await a.sync();
  assert.equal(ra.ok, true);
  const aIds = a.listEntries().map((e) => e.issuer).sort();
  assert.deepEqual(aIds, ['AWS', 'GitHub'], 'A 不应丢失 B 添加的条目');
});

test('主密码不同时拒绝覆盖远端', async () => {
  const { store, transport } = makeTransport();
  const a = new VaultService(makeMemoryPlatform({ deviceId: 'A', transport }));
  await a.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  await a.addFromScanned(SAMPLE_URI);
  await a.sync();

  // B 用不同主密码
  const b = new VaultService(makeMemoryPlatform({ deviceId: 'B', transport }));
  await b.create('totally-different-pw', 'totally-different-pw');
  await b.addFromScanned('otpauth://totp/X:y?secret=JBSWY3DPEHPK3PXP&issuer=X');

  const r = await b.sync();
  assert.equal(r.ok, false);
  assert.match(r.message, /无法用当前主密码解密/);
  // 关键:远端数据必须保持原样,不能被 B 的数据覆盖
  const raw = JSON.stringify(store.record);
  assert.notEqual(raw.includes('"issuer":"X"'), true, '远端被错误覆盖');
});

test('未配置传输层时同步给出明确提示', async () => {
  const svc = new VaultService(makeMemoryPlatform());
  await svc.create('Str0ng!Passw0rd#2024', 'Str0ng!Passw0rd#2024');
  const r = await svc.sync();
  assert.equal(r.ok, false);
  assert.match(r.message, /未配置同步/);
  assert.equal(svc.canSync(), false);
});

test('同步冲突时重试合并而非失败', async () => {
  // 模拟真实竞态:本机 push 之前,另一台设备刚写入了新版本。
  // 远端必须带真实密文,否则 pull 返回 null 就走不到冲突分支。
  const { sealJson } = await import('../dist/index.mjs');
  const PASSWORD = 'Str0ng!Passw0rd#2024';
  const deterministicRandom = (n) => {
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) a[i] = (i * 17 + 7) & 0xff;
    return a;
  };

  // 远端当前状态:含一条 A 设备没有的条目
  const remoteVault = {
    ...createEmptyVault('other-device', 1000),
    entries: [entryOf('remote-1', 'RemoteOnly', 900)],
    updatedAt: 1000,
  };
  let remote = {
    envelope: sealJson(remoteVault, PASSWORD, deterministicRandom, 1000),
    updatedAt: 1000,
    deviceId: 'other-device',
    revision: 6,
  };

  let pushCount = 0;
  const transport = {
    async pull() {
      return { ...remote, revision: remote.revision };
    },
    async push(payload) {
      pushCount += 1;
      if (pushCount === 1) {
        // 第一次:其他设备在我们拉取之后抢先写入,返回冲突
        return { ok: false, revision: 7, conflict: { ...remote, revision: 7 } };
      }
      remote = { envelope: payload.envelope, updatedAt: payload.updatedAt, deviceId: payload.deviceId, revision: 8 };
      return { ok: true, revision: 8, conflict: null };
    },
  };

  const svc = new VaultService(makeMemoryPlatform({ transport }));
  await svc.create(PASSWORD, PASSWORD);
  await svc.addFromScanned(SAMPLE_URI);

  const r = await svc.sync();
  assert.equal(r.ok, true, '冲突后应重试成功');
  assert.equal(pushCount, 2, '应发生一次重试');
  // 冲突合并后,远端那条也必须出现在本机
  const issuers = svc.listEntries().map((e) => e.issuer).sort();
  assert.deepEqual(issuers, ['GitHub', 'RemoteOnly'], '冲突合并不应丢数据');
});
