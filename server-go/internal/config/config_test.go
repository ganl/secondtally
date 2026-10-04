// SPDX-License-Identifier: AGPL-3.0-only

package config

import (
	"strings"
	"testing"
)

// env 把 map 转成 Getenv,便于逐用例构造环境。
func env(m map[string]string) Getenv {
	return func(k string) string { return m[k] }
}

func devBase(extra map[string]string) map[string]string {
	m := map[string]string{
		"TWOFA_ALLOWED_ORIGINS": "http://localhost:5173",
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

// prodBase 给出合法的生产环境基线,只把"被测的那个变量"留给用例自己填。
//
// 为什么抽出来:生产环境现在硬性要求 TWOFA_DATABASE_URL,
// 每个用例都手写全套配置的话,以后每加一条生产硬约束就要改十几处,
// 而且漏改的那几处会以"错误的理由"通过——比如本该测密钥校验,
// 却先撞上数据库连接串缺失,测试变成假绿。
//
// 刻意不设 TWOFA_TOKEN_SECRET:有几个用例正是要测密钥校验,
// 由它们自己决定填什么或不填。
func prodBase(extra map[string]string) map[string]string {
	m := map[string]string{
		"TWOFA_ENV":             "production",
		"TWOFA_ALLOWED_ORIGINS": "https://2fa.example.com",
		"TWOFA_DATABASE_URL":    "postgres://u:p@h:5432/twofa?sslmode=require",
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestLoadDevelopmentDefaults(t *testing.T) {
	cfg, err := Load(env(devBase(nil)))
	if err != nil {
		t.Fatalf("开发环境应能加载: %v", err)
	}
	if cfg.Port != 8787 {
		t.Errorf("默认端口应为 8787, 得到 %d", cfg.Port)
	}
	if cfg.Host != "127.0.0.1" {
		t.Errorf("默认应只监听本机, 得到 %q", cfg.Host)
	}
	if cfg.IsProduction {
		t.Error("未设TWOFA_ENV 时不应判定为生产环境")
	}
	if cfg.AccessTokenTTL.Seconds() != 3600 {
		t.Errorf("默认令牌有效期应为 1 小时, 得到 %v", cfg.AccessTokenTTL)
	}
	if len(cfg.AllowedOrigins) != 1 {
		t.Errorf("应解析出 1 个来源, 得到 %v", cfg.AllowedOrigins)
	}
}

// TestProductionRejectsMissingSecret 是最重要的一条:
// 生产环境缺密钥必须拒绝启动,不能静默用开发默认值跑起来。
func TestProductionRejectsMissingSecret(t *testing.T) {
	_, err := Load(env(prodBase(nil)))
	if err == nil {
		t.Fatal("生产环境缺少 TWOFA_TOKEN_SECRET 应拒绝启动")
	}
	if !strings.Contains(err.Error(), "TWOFA_TOKEN_SECRET") {
		t.Errorf("错误信息应指明是哪个变量缺失: %v", err)
	}
}

func TestProductionRejectsDevSecret(t *testing.T) {
	_, err := Load(env(prodBase(map[string]string{
		"TWOFA_TOKEN_SECRET": devSecret,
	})))
	if err == nil {
		t.Fatal("生产环境使用开发默认密钥应被拒绝")
	}
}

func TestProductionRejectsShortSecret(t *testing.T) {
	_, err := Load(env(prodBase(map[string]string{
		"TWOFA_TOKEN_SECRET": strings.Repeat("a", 31), // 差一个字符
	})))
	if err == nil {
		t.Fatal("密钥短于 32 字符应被拒绝")
	}
}

func TestProductionRejectsWildcardCORS(t *testing.T) {
	_, err := Load(env(prodBase(map[string]string{
		"TWOFA_ALLOWED_ORIGINS": "*,https://2fa.example.com",
	})))
	if err == nil {
		t.Fatal("生产环境 CORS 通配符应被拒绝")
	}
}

func TestProductionRequiresHTTPSOrigin(t *testing.T) {
	_, err := Load(env(prodBase(map[string]string{
		"TWOFA_ALLOWED_ORIGINS": "http://2fa.example.com", // 明文
	})))
	if err == nil {
		t.Fatal("生产环境没有任何 https 来源应被拒绝")
	}
}

func TestProductionAcceptsHTTPSOrigin(t *testing.T) {
	cfg, err := Load(env(prodBase(map[string]string{
		"TWOFA_TOKEN_SECRET":    strings.Repeat("k", 64),
		"TWOFA_ALLOWED_ORIGINS": "https://2fa.example.com, https://mini.example.com",
	})))
	if err != nil {
		t.Fatalf("合法生产配置应能加载: %v", err)
	}
	if len(cfg.AllowedOrigins) != 2 {
		t.Errorf("应解析出 2 个来源, 得到 %v", cfg.AllowedOrigins)
	}
	// 带空格的逗号列表必须被正确切分,不能留下前导空格。
	if cfg.AllowedOrigins[1] != "https://mini.example.com" {
		t.Errorf("来源不应带空格: %q", cfg.AllowedOrigins[1])
	}
}

func TestPortValidation(t *testing.T) {
	for _, port := range []string{"0", "65536", "abc", "-1"} {
		if _, err := Load(env(devBase(map[string]string{"PORT": port}))); err == nil {
			t.Errorf("非法端口 %q 应被拒绝", port)
		}
	}
	for _, port := range []string{"1", "8080", "65535"} {
		if _, err := Load(env(devBase(map[string]string{"PORT": port}))); err != nil {
			t.Errorf("合法端口 %q 应被接受: %v", port, err)
		}
	}
}

func TestTokenTTLValidation(t *testing.T) {
	for _, ttl := range []string{"0", "59", "2592001", "abc"} {
		if _, err := Load(env(devBase(map[string]string{"TWOFA_TOKEN_TTL": ttl}))); err == nil {
			t.Errorf("非法 TTL %q 应被拒绝", ttl)
		}
	}
	if _, err := Load(env(devBase(map[string]string{"TWOFA_TOKEN_TTL": "60"}))); err != nil {
		t.Errorf("TTL 下界 60 应被接受: %v", err)
	}
}

func TestDataDirResolvedToAbsolute(t *testing.T) {
	cfg, err := Load(env(devBase(map[string]string{"TWOFA_DATA_DIR": "./relative/data"})))
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	// 相对路径必须在启动时就转成绝对路径——
	// 否则 systemd 切换 WorkingDirectory 后会写到别处。
	if !strings.HasPrefix(filepath2Slash(cfg.DataDir), "/") &&
		!strings.Contains(cfg.DataDir, ":\\") {
		t.Errorf("DataDir 应为绝对路径, 得到 %q", cfg.DataDir)
	}
}

// filepath2Slash 让 Windows 路径也能通过"以 / 开头"的前缀检查。
func filepath2Slash(p string) string { return strings.ReplaceAll(p, "\\", "/") }

// TestNodeEnvCompatibility 验证迁移期同一份 .env 能供两版共用。
func TestNodeEnvCompatibility(t *testing.T) {
	cfg, err := Load(env(devBase(map[string]string{"NODE_ENV": "production"})))
	if err == nil {
		t.Fatal("仅设 NODE_ENV=production 也应触发生产校验")
	}
	_ = cfg
}

// TestBlankOriginListFallsBackToLocalhost 确认未配 CORS 时
// 回退到本地开发地址,而不是空列表(空列表会让浏览器全拒)。
func TestBlankOriginListFallsBackToLocalhost(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"TWOFA_ALLOWED_ORIGINS": "   ",
	}))
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if len(cfg.AllowedOrigins) == 0 {
		t.Error("空白 CORS 配置应回退到默认值, 而非空列表")
	}
	joined := strings.Join(cfg.AllowedOrigins, ",")
	if !strings.Contains(joined, "localhost") {
		t.Errorf("回退值应含本地开发地址, 得到 %q", joined)
	}
}

// ---- 数据库配置 ----

// TestDevDefaultsToSQLite 确认开发环境默认 SQLite。
//
// 本地开发与测试不该被强制装一个数据库。
func TestDevDefaultsToSQLite(t *testing.T) {
	cfg, err := Load(env(devBase(nil)))
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if cfg.DBDriver != "sqlite" {
		t.Errorf("开发环境默认应为 sqlite, 得到 %q", cfg.DBDriver)
	}
}

// TestProductionDefaultsToPostgres 是本轮改动的核心断言。
//
// 用户量上来后 SQLite 整库串行写会成为瓶颈,
// 所以生产环境默认必须换成 PostgreSQL。
func TestProductionDefaultsToPostgres(t *testing.T) {
	// 刻意不设 TWOFA_DB_DRIVER,验证默认值本身。
	cfg, err := Load(env(prodBase(map[string]string{
		"TWOFA_TOKEN_SECRET": strings.Repeat("a", 40),
	})))
	if err != nil {
		t.Fatalf("合法生产配置应能加载: %v", err)
	}
	if cfg.DBDriver != "postgres" {
		t.Errorf("生产环境默认应为 postgres, 得到 %q", cfg.DBDriver)
	}
	if cfg.DatabaseURL == "" {
		t.Error("连接串应被保留")
	}
}

// TestExplicitSQLiteAllowedInProduction 确认允许显式选择 SQLite。
//
// "单机小规模部署"是真实场景,程序不该替用户做这个决定。
// 注意:必须清掉连接串——带了连接串却不选 PG,属于配错,会打警告。
func TestExplicitSQLiteAllowedInProduction(t *testing.T) {
	cfg, err := Load(env(prodBase(map[string]string{
		"TWOFA_TOKEN_SECRET": strings.Repeat("a", 40),
		"TWOFA_DB_DRIVER":    "sqlite",
		// 显式置空,覆盖基线里的连接串。
		"TWOFA_DATABASE_URL": "",
	})))
	if err != nil {
		t.Fatalf("生产环境显式选 SQLite 应被允许: %v", err)
	}
	if cfg.DBDriver != "sqlite" {
		t.Errorf("显式配置应生效, 得到 %q", cfg.DBDriver)
	}
}

// TestPostgresRequiresURL 确认选了 PG 就必须给连接串。
func TestPostgresRequiresURL(t *testing.T) {
	_, err := Load(env(devBase(map[string]string{
		"TWOFA_DB_DRIVER": "postgres",
	})))
	if err == nil {
		t.Fatal("PG 模式缺连接串应报错")
	}
	if !strings.Contains(err.Error(), "TWOFA_DATABASE_URL") {
		t.Errorf("报错应指明环境变量名, 得到 %q", err.Error())
	}
}

// TestUnknownDBDriverRejected 确认配错数据库类型时明确失败,
// 而不是静默回落——那会把生产数据写进本地文件。
func TestUnknownDBDriverRejected(t *testing.T) {
	_, err := Load(env(devBase(map[string]string{
		"TWOFA_DB_DRIVER": "mysql",
	})))
	if err == nil {
		t.Fatal("未知数据库类型应报错")
	}
	if !strings.Contains(err.Error(), "sqlite") || !strings.Contains(err.Error(), "postgres") {
		t.Errorf("报错应提示可选值, 得到 %q", err.Error())
	}
}

// TestDBDriverCaseInsensitive 确认大小写不敏感。
//
// 手写配置时 POSTGRES 与 postgres 混用很常见。
func TestDBDriverCaseInsensitive(t *testing.T) {
	cfg, err := Load(env(devBase(map[string]string{
		"TWOFA_DB_DRIVER":    "PostGreS",
		"TWOFA_DATABASE_URL": "postgres://u:p@h:5432/db",
	})))
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if cfg.DBDriver != "postgres" {
		t.Errorf("应归一化为小写, 得到 %q", cfg.DBDriver)
	}
}

// TestProductionPostgresWithoutURLFails 锁住生产环境的一条硬约束。
func TestProductionPostgresWithoutURLFails(t *testing.T) {
	_, err := Load(env(prodBase(map[string]string{
		"TWOFA_TOKEN_SECRET": strings.Repeat("a", 40),
		"TWOFA_DATABASE_URL": "", // 覆盖基线,模拟"忘了配连接串"
	})))
	if err == nil {
		t.Fatal("生产环境未配数据库连接串应报错")
	}
	if !strings.Contains(err.Error(), "TWOFA_DATABASE_URL") {
		t.Errorf("报错应指明缺哪个变量, 得到 %q", err.Error())
	}
}
