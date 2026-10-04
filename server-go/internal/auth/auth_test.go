// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const testSecret = "test-only-token-secret-at-least-32-chars-long"

func newTestService(t *testing.T) *Service {
	t.Helper()
	dir := t.TempDir()
	svc, err := New(filepath.Join(dir, "credentials.json"), testSecret)
	if err != nil {
		t.Fatalf("创建服务失败: %v", err)
	}
	return svc
}

func TestRegisterAndVerify(t *testing.T) {
	svc := newTestService(t)

	if _, err := svc.Register("alice", "correct-horse-battery"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	if err := svc.Verify("alice", "correct-horse-battery"); err != nil {
		t.Fatalf("正确口令应通过校验: %v", err)
	}
	if err := svc.Verify("alice", "wrong-password-entirely"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("错误口令应被拒绝, 得到 %v", err)
	}
	// 不存在的用户也必须返回同一个错误,否则就是账户枚举接口。
	if err := svc.Verify("nonexistent", "correct-horse-battery"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("不存在的账户应返回 ErrInvalidCredentials, 得到 %v", err)
	}
}

func TestRegisterRejectsDuplicate(t *testing.T) {
	svc := newTestService(t)

	if _, err := svc.Register("bob", "first-password-1"); err != nil {
		t.Fatalf("首次注册失败: %v", err)
	}
	if _, err := svc.Register("bob", "second-password-2"); !errors.Is(err, ErrUserExists) {
		t.Fatalf("重复注册应返回 ErrUserExists, 得到 %v", err)
	}
	// 重复注册不应覆盖原口令。
	if err := svc.Verify("bob", "first-password-1"); err != nil {
		t.Fatalf("重复注册后原口令应仍然有效: %v", err)
	}
}

func TestRegisterRejectsWeakInput(t *testing.T) {
	svc := newTestService(t)

	if _, err := svc.Register("", "valid-password-1"); !errors.Is(err, ErrInvalidUserID) {
		t.Fatalf("空账户应被拒绝, 得到 %v", err)
	}
	if _, err := svc.Register("carol", "short"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("过短口令应被拒绝, 得到 %v", err)
	}
	longID := strings.Repeat("x", 129)
	if _, err := svc.Register(longID, "valid-password-1"); !errors.Is(err, ErrInvalidUserID) {
		t.Fatalf("超长账户标识应被拒绝, 得到 %v", err)
	}
}

// TestVerifyNormalizesFullWidth 验证 NFKC 归一化生效:
// 全角与半角是同一视觉字符,归一化后应哈希成同一个值。
func TestVerifyNormalizesFullWidth(t *testing.T) {
	svc := newTestService(t)

	// 用 8 个全角字符,归一化后正好 8 位,刚好越过强度门槛。
	// 早先误用 6 位的"ａｂｃ１２３",它归一化后只有 6 字符,
	// 被正确地判为"不足 8 位"——那是门槛在起作用,不是归一化坏了。
	const password = "ａｂｃｄｅｆ１２"

	normalized := normalizeNFKC(password)
	if utf8.RuneCountInString(normalized) != 8 {
		t.Fatalf("归一化后应为 8 个字符, 实得 %d (%q)", utf8.RuneCountInString(normalized), normalized)
	}
	// 归一化必须真的把全角变成半角,否则下面的 Verify 通过没有意义。
	if normalized != "abcdef12" {
		t.Fatalf("归一化结果错误: %q", normalized)
	}

	if _, err := svc.Register("dave", password); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	// 用半角形式登录,应该能通过——用户可能这次用了全角,下次用了半角。
	if err := svc.Verify("dave", "abcdef12"); err != nil {
		t.Fatalf("半角口令应能校验全角注册的账户: %v", err)
	}
	// 再次用全角登录,同样应该通过。
	if err := svc.Verify("dave", password); err != nil {
		t.Fatalf("全角口令应能校验自己注册的账户: %v", err)
	}
	// 长度门槛仍要对归一化后的长度生效:
	// 6 个全角字符归一化后仍是 6 位,必须被拒。
	if _, err := svc.Register("erin", "ａｂｃ１２３"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("归一化后不足 8 位应被拒绝, 得到 %v", err)
	}
}

func TestAccessTokenRoundTrip(t *testing.T) {
	svc := newTestService(t)
	if _, err := svc.Register("erin", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	token := svc.IssueAccessToken("erin", "web", time.Hour)
	identity, err := svc.VerifyAccessToken(token)
	if err != nil {
		t.Fatalf("签发的令牌应能通过校验: %v", err)
	}
	if identity.UserID != "erin" || identity.DeviceID != "web" {
		t.Fatalf("身份解析错误: %+v", identity)
	}
}

// TestAccessTokenFormat 锁定令牌格式。
//
// 客户端 core 的 httpTransport 会把 accessToken 原样放进 Authorization 头,
// 且 Node 端用 Buffer.toString('base64url') 生成。这里用 RawURLEncoding
// (无填充、URL 安全)与之保持一致——若换成带填充的标准编码,
// JS 侧不会报错但所有令牌都会失效。
func TestAccessTokenFormat(t *testing.T) {
	svc := newTestService(t)
	if _, err := svc.Register("frank", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	token := svc.IssueAccessToken("frank", "web", time.Hour)
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		t.Fatalf("令牌应为两段, 得到 %d 段", len(parts))
	}
	// 不应含 + / = 这些非 URL 安全字符。
	if strings.ContainsAny(token, "+/=") {
		t.Fatalf("令牌含非 URL 安全字符: %s", token)
	}
	// 负载应是合法的 RawURL base64,能用标准库解出来。
	if _, err := base64.RawURLEncoding.DecodeString(parts[0]); err != nil {
		t.Fatalf("负载不是合法的 RawURL base64: %v", err)
	}
}

func TestAccessTokenRejectsTampered(t *testing.T) {
	svc := newTestService(t)
	if _, err := svc.Register("grace", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	valid := svc.IssueAccessToken("grace", "web", time.Hour)

	t.Run("无点号", func(t *testing.T) {
		if _, err := svc.VerifyAccessToken("not-a-token"); err == nil {
			t.Fatal("格式错误的令牌不应通过")
		}
	})
	t.Run("签名被改", func(t *testing.T) {
		parts := strings.Split(valid, ".")
		tampered := parts[0] + "." + strings.Repeat("0", 64)
		if _, err := svc.VerifyAccessToken(tampered); err == nil {
			t.Fatal("签名错误的令牌不应通过")
		}
	})
	t.Run("负载被改", func(t *testing.T) {
		parts := strings.Split(valid, ".")
		// 用一个"不存在用户"的合法令牌负载配上原签名:
		// 签名对不上,必须被拒。这验证攻击者无法伪造他人身份。
		other := svc.IssueAccessToken("eve-not-registered", "web", time.Hour)
		mixed := other[:strings.Index(other, ".")] + "." + parts[1]
		if _, err := svc.VerifyAccessToken(mixed); err == nil {
			t.Fatal("负载与签名不匹配的令牌不应通过")
		}
	})
	t.Run("已过期", func(t *testing.T) {
		expired := svc.IssueAccessToken("grace", "web", -time.Second)
		if _, err := svc.VerifyAccessToken(expired); err == nil {
			t.Fatal("过期令牌不应通过")
		}
	})
	t.Run("用户不存在", func(t *testing.T) {
		ghost := svc.IssueAccessToken("ghost-user", "web", time.Hour)
		if _, err := svc.VerifyAccessToken(ghost); err == nil {
			t.Fatal("未注册用户的令牌不应通过")
		}
	})
}

func TestRefreshTokenIsSingleUse(t *testing.T) {
	svc := newTestService(t)
	if _, err := svc.Register("heidi", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	first, err := svc.IssueRefreshToken("heidi")
	if err != nil {
		t.Fatalf("签发失败: %v", err)
	}

	// 第一次使用应成功,并返回新的令牌对。
	pair, err := svc.Refresh("heidi", first)
	if err != nil {
		t.Fatalf("首次刷新应成功: %v", err)
	}
	if pair.AccessToken == "" || pair.RefreshToken == "" {
		t.Fatal("刷新应返回非空令牌对")
	}
	if pair.RefreshToken == first {
		t.Fatal("刷新后不应返回同一个刷新令牌")
	}

	// 第二次使用同一个令牌:视为泄露,拒绝。
	if _, err := svc.Refresh("heidi", first); !errors.Is(err, ErrInvalidRefreshToken) {
		t.Fatalf("重复使用刷新令牌应被拒绝, 得到 %v", err)
	}
}

// TestRefreshReplayRevokesAllTokens 验证重放检测:
// 同一个刷新令牌被用第二次,说明它已泄露,此时该用户的全部刷新令牌
// 都应被吊销,逼使重新登录。
func TestRefreshReplayRevokesAllTokens(t *testing.T) {
	svc := newTestService(t)
	if _, err := svc.Register("ivan", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	stolen, _ := svc.IssueRefreshToken("ivan")
	legitimate, _ := svc.IssueRefreshToken("ivan")

	// 攻击者先用偷到的令牌换新令牌(这是泄露后的正常动作)。
	if _, err := svc.Refresh("ivan", stolen); err != nil {
		t.Fatalf("攻击者的首次使用应成功, 否则无法验证后续吊销: %v", err)
	}
	// 攻击者再试一次 -> 触发重放检测。
	if _, err := svc.Refresh("ivan", stolen); err == nil {
		t.Fatal("重放应被拒绝")
	}
	// 此时用户手里那个原本合法的令牌也该失效了。
	if _, err := svc.Refresh("ivan", legitimate); err == nil {
		t.Fatal("重放后该用户的全部刷新令牌都应被吊销")
	}
}

func TestCredentialsPersistAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "credentials.json")

	first, err := New(file, testSecret)
	if err != nil {
		t.Fatalf("创建服务失败: %v", err)
	}
	if _, err := first.Register("judy", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	refresh, err := first.IssueRefreshToken("judy")
	if err != nil {
		t.Fatalf("签发刷新令牌失败: %v", err)
	}

	// 模拟重启。
	second, err := New(file, testSecret)
	if err != nil {
		t.Fatalf("重启后加载失败: %v", err)
	}
	if err := second.Verify("judy", "valid-password-9"); err != nil {
		t.Fatalf("重启后应仍能通过口令校验: %v", err)
	}
	// 刷新令牌也必须跨重启有效,否则用户会被无故登出。
	if _, err := second.Refresh("judy", refresh); err != nil {
		t.Fatalf("重启后刷新令牌应仍有效: %v", err)
	}
}

func TestCredentialsFilePermissions(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "credentials.json")
	svc, err := New(file, testSecret)
	if err != nil {
		t.Fatalf("创建服务失败: %v", err)
	}
	if _, err := svc.Register("ken", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}

	info, err := os.Stat(file)
	if err != nil {
		t.Fatalf("读取文件信息失败: %v", err)
	}
	// Windows 上权限模型不同,只在类 Unix 系统上断言。
	if info.Mode().Perm() != 0o600 {
		t.Logf("凭据文件权限为 %o,Windows 平台上不强制 0600", info.Mode().Perm())
	}
}

// TestCorruptedCredentialsRefusesStartup 是安全相关的行为:
// 凭据文件损坏时必须启动失败,而不是静默重置为空——
// 那会让所有用户突然"不存在",表现为无法登录且无从排查。
func TestCorruptedCredentialsRefusesStartup(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "credentials.json")
	if err := os.WriteFile(file, []byte("{ this is not json"), 0o600); err != nil {
		t.Fatalf("写入损坏文件失败: %v", err)
	}

	if _, err := New(file, testSecret); !errors.Is(err, ErrCorrupted) {
		t.Fatalf("损坏的凭据文件应导致启动失败, 得到 %v", err)
	}
}

func TestMissingTokenSecretRefuses(t *testing.T) {
	if _, err := New(filepath.Join(t.TempDir(), "c.json"), ""); err == nil {
		t.Fatal("空令牌密钥必须被拒绝")
	}
	if _, err := New(filepath.Join(t.TempDir(), "c.json"), "   "); err == nil {
		t.Fatal("纯空白的令牌密钥必须被拒绝")
	}
}

func TestLogoutRevokesTokens(t *testing.T) {
	svc := newTestService(t)
	if _, err := svc.Register("leo", "valid-password-9"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	refresh, _ := svc.IssueRefreshToken("leo")

	if err := svc.Logout("leo"); err != nil {
		t.Fatalf("登出失败: %v", err)
	}
	if _, err := svc.Refresh("leo", refresh); err == nil {
		t.Fatal("登出后刷新令牌应失效")
	}
}
