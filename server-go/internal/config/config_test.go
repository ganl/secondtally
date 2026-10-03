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
		"AEGIS_ALLOWED_ORIGINS": "http://localhost:5173",
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
		t.Error("未设AEGIS_ENV 时不应判定为生产环境")
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
	_, err := Load(env(devBase(map[string]string{"AEGIS_ENV": "production"})))
	if err == nil {
		t.Fatal("生产环境缺少 AEGIS_TOKEN_SECRET 应拒绝启动")
	}
	if !strings.Contains(err.Error(), "AEGIS_TOKEN_SECRET") {
		t.Errorf("错误信息应指明是哪个变量缺失: %v", err)
	}
}

func TestProductionRejectsDevSecret(t *testing.T) {
	_, err := Load(env(devBase(map[string]string{
		"AEGIS_ENV":          "production",
		"AEGIS_TOKEN_SECRET": devSecret,
	})))
	if err == nil {
		t.Fatal("生产环境使用开发默认密钥应被拒绝")
	}
}

func TestProductionRejectsShortSecret(t *testing.T) {
	_, err := Load(env(devBase(map[string]string{
		"AEGIS_ENV":          "production",
		"AEGIS_TOKEN_SECRET": strings.Repeat("a", 31), // 差一个字符
	})))
	if err == nil {
		t.Fatal("密钥短于 32 字符应被拒绝")
	}
}

func TestProductionRejectsWildcardCORS(t *testing.T) {
	_, err := Load(env(map[string]string{
		"AEGIS_ENV":             "production",
		"AEGIS_TOKEN_SECRET":    strings.Repeat("k", 64),
		"AEGIS_ALLOWED_ORIGINS": "*,https://2fa.example.com",
	}))
	if err == nil {
		t.Fatal("生产环境 CORS 通配符应被拒绝")
	}
}

func TestProductionRequiresHTTPSOrigin(t *testing.T) {
	_, err := Load(env(map[string]string{
		"AEGIS_ENV":             "production",
		"AEGIS_TOKEN_SECRET":    strings.Repeat("k", 64),
		"AEGIS_ALLOWED_ORIGINS": "http://2fa.example.com", // 明文
	}))
	if err == nil {
		t.Fatal("生产环境没有任何 https 来源应被拒绝")
	}
}

func TestProductionAcceptsHTTPSOrigin(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"AEGIS_ENV":             "production",
		"AEGIS_TOKEN_SECRET":    strings.Repeat("k", 64),
		"AEGIS_ALLOWED_ORIGINS": "https://2fa.example.com, https://mini.example.com",
	}))
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
		if _, err := Load(env(devBase(map[string]string{"AEGIS_TOKEN_TTL": ttl}))); err == nil {
			t.Errorf("非法 TTL %q 应被拒绝", ttl)
		}
	}
	if _, err := Load(env(devBase(map[string]string{"AEGIS_TOKEN_TTL": "60"}))); err != nil {
		t.Errorf("TTL 下界 60 应被接受: %v", err)
	}
}

func TestDataDirResolvedToAbsolute(t *testing.T) {
	cfg, err := Load(env(devBase(map[string]string{"AEGIS_DATA_DIR": "./relative/data"})))
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
		"AEGIS_ALLOWED_ORIGINS": "   ",
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
