package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"aegis/server/internal/auth"
	"aegis/server/internal/config"
	"aegis/server/internal/store"
)

func newTestServer(t *testing.T) (*httptest.Server, *store.Repository) {
	t.Helper()

	dir := t.TempDir()
	cfg := &config.Config{
		Port:           0,
		Host:           "127.0.0.1",
		DataDir:        dir,
		TokenSecret:    "test-only-token-secret-at-least-32-chars",
		AllowedOrigins: []string{"https://2fa.example.com"},
		AccessTokenTTL: time.Hour,
		IsProduction:   false,
	}

	authSvc, err := auth.New(filepath.Join(dir, "credentials.json"), cfg.TokenSecret)
	if err != nil {
		t.Fatalf("创建认证服务失败: %v", err)
	}
	repo, err := store.Open(filepath.Join(dir, "vaults.db"))
	if err != nil {
		t.Fatalf("打开存储失败: %v", err)
	}

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := New(cfg, authSvc, repo, log)
	srv := httptest.NewServer(api.Handler())
	t.Cleanup(func() {
		srv.Close()
		_ = repo.Close()
	})
	return srv, repo
}

// do 发起请求并解析 JSON 响应。
func do(t *testing.T, srv *httptest.Server, method, path string, body any, token string) (int, map[string]any) {
	t.Helper()

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, srv.URL+path, reader)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	// 不跟随重定向:状态码本身就是断言对象。
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	out := make(map[string]any)
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("响应不是合法 JSON (%s): %v", string(raw), err)
		}
	}
	return resp.StatusCode, out
}

// registerAndLogin 返回一个可用的访问令牌。
func registerAndLogin(t *testing.T, srv *httptest.Server, userID, password string) string {
	t.Helper()
	status, body := do(t, srv, "POST", "/api/v1/auth/register", map[string]any{
		"userId": userID, "password": password,
	}, "")
	if status != http.StatusCreated {
		t.Fatalf("注册应返回 201, 得到 %d: %v", status, body)
	}
	token, _ := body["accessToken"].(string)
	if token == "" {
		t.Fatal("注册响应缺少 accessToken")
	}
	return token
}

func TestHealthAndReady(t *testing.T) {
	srv, _ := newTestServer(t)

	if status, body := do(t, srv, "GET", "/health", nil, ""); status != 200 {
		t.Fatalf("/health 应返回 200, 得到 %d", status)
	} else if body["status"] != "ok" {
		t.Fatalf("/health status 异常: %v", body)
	}

	if status, body := do(t, srv, "GET", "/ready", nil, ""); status != 200 {
		t.Fatalf("/ready 应返回 200, 得到 %d: %v", status, body)
	} else if body["storage"] != "ok" {
		t.Fatalf("/ready 应确认存储可用: %v", body)
	}
}

func TestRegisterLoginFlow(t *testing.T) {
	srv, _ := newTestServer(t)

	status, body := do(t, srv, "POST", "/api/v1/auth/register", map[string]any{
		"userId": "alice", "password": "correct-horse-battery",
	}, "")
	if status != http.StatusCreated {
		t.Fatalf("注册应返回 201, 得到 %d: %v", status, body)
	}
	for _, key := range []string{"accessToken", "refreshToken", "expiresIn"} {
		if _, ok := body[key]; !ok {
			t.Fatalf("注册响应缺少字段 %s: %v", key, body)
		}
	}

	// 重复注册返回 409
	if status, _ := do(t, srv, "POST", "/api/v1/auth/register", map[string]any{
		"userId": "alice", "password": "another-password-1",
	}, ""); status != http.StatusConflict {
		t.Fatalf("重复注册应返回 409, 得到 %d", status)
	}

	// 正确口令登录成功
	if status, body := do(t, srv, "POST", "/api/v1/auth/login", map[string]any{
		"userId": "alice", "password": "correct-horse-battery",
	}, ""); status != 200 {
		t.Fatalf("登录应返回 200, 得到 %d: %v", status, body)
	}

	// 错误口令与不存在账户必须返回完全相同的状态码与错误码,
	// 否则就成了账户枚举接口。
	wrongStatus, wrongBody := do(t, srv, "POST", "/api/v1/auth/login", map[string]any{
		"userId": "alice", "password": "wrong-password-here",
	}, "")
	ghostStatus, ghostBody := do(t, srv, "POST", "/api/v1/auth/login", map[string]any{
		"userId": "does-not-exist", "password": "wrong-password-here",
	}, "")

	if wrongStatus != ghostStatus {
		t.Fatalf("错密码与不存在账户的状态码应相同: %d vs %d", wrongStatus, ghostStatus)
	}
	if wrongStatus != http.StatusUnauthorized {
		t.Fatalf("错误口令应返回 401, 得到 %d", wrongStatus)
	}
	// 错误码也必须一致。
	if codeOf(wrongBody) != codeOf(ghostBody) {
		t.Fatalf("错误码应一致, 否则可枚举账户: %q vs %q", codeOf(wrongBody), codeOf(ghostBody))
	}
}

func codeOf(body map[string]any) string {
	errObj, _ := body["error"].(map[string]any)
	code, _ := errObj["code"].(string)
	return code
}

func TestAuthRequired(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "bob", "valid-password-99")

	t.Run("无令牌", func(t *testing.T) {
		if status, _ := do(t, srv, "GET", "/api/v1/vault", nil, ""); status != http.StatusUnauthorized {
			t.Fatalf("无令牌应返回 401, 得到 %d", status)
		}
	})
	t.Run("伪造令牌", func(t *testing.T) {
		if status, _ := do(t, srv, "GET", "/api/v1/vault", nil, "forged.token.value"); status != http.StatusUnauthorized {
			t.Fatalf("伪造令牌应返回 401, 得到 %d", status)
		}
	})
	t.Run("空Bearer", func(t *testing.T) {
		req, _ := http.NewRequest("GET", srv.URL+"/api/v1/vault", nil)
		req.Header.Set("Authorization", "Bearer ")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("空令牌应返回 401, 得到 %d", resp.StatusCode)
		}
	})
	t.Run("合法令牌", func(t *testing.T) {
		if status, _ := do(t, srv, "GET", "/api/v1/vault", nil, token); status != 200 {
			t.Fatalf("合法令牌应通过, 得到 %d", status)
		}
	})
}

// TestVaultPullPushRoundTrip 验证密文能原样往返。
//
// 这是整个系统的核心承诺:服务端搬的是密文,不能改动它。
func TestVaultPullPushRoundTrip(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "carol", "valid-password-99")

	// 初始没有记录
	status, body := do(t, srv, "GET", "/api/v1/vault", nil, token)
	if status != 200 {
		t.Fatalf("拉取应返回 200, 得到 %d", status)
	}
	if body["record"] != nil {
		t.Fatalf("初始拉取应返回 record: null, 得到 %v", body["record"])
	}

	// 模拟真实密文结构(嵌套的 envelope)
	envelope := map[string]any{
		"v": 1, "kdf": "pbkdf2-sha256", "iterations": 210000,
		"salt":  "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
		"nonce": "aabbccddeeff001122334455",
		"ct":    "99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa",
	}
	updatedAt := time.Now().UnixMilli()

	status, body = do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope": envelope, "updatedAt": updatedAt,
		"deviceId": "web-1", "baseRevision": nil,
	}, token)
	if status != 200 {
		t.Fatalf("首次上传应返回 200, 得到 %d: %v", status, body)
	}
	if body["ok"] != true {
		t.Fatalf("首次上传应成功: %v", body)
	}
	if revision, _ := body["revision"].(float64); revision != 1 {
		t.Fatalf("首次上传后 revision 应为 1, 得到 %v", body["revision"])
	}

	// 拉回来应与上传的完全一致
	_, body = do(t, srv, "GET", "/api/v1/vault", nil, token)
	record, _ := body["record"].(map[string]any)
	if record == nil {
		t.Fatal("上传后应能拉回记录")
	}
	got, _ := record["envelope"].(map[string]any)
	if got == nil {
		t.Fatalf("envelope 结构异常: %v", record["envelope"])
	}
	for k, want := range envelope {
		if got[k] != want {
			t.Errorf("envelope 字段 %s 不一致: 期望 %v, 得到 %v", k, want, got[k])
		}
	}
	if record["deviceId"] != "web-1" {
		t.Errorf("deviceId 应被保留, 得到 %v", record["deviceId"])
	}
}

// TestVaultConditionalWriteConflict 是防丢数据的关键测试。
//
// 客户端用乐观并发:推送时带上自己看到的 baseRevision,
// 服务端只在版本匹配时才接受。版本不匹配必须返回 409 且原数据完好。
func TestVaultConditionalWriteConflict(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "dave", "valid-password-99")

	first := map[string]any{"v": 1, "ct": "aaaa"}
	updatedAt := time.Now().UnixMilli()

	// 首次写入
	if status, _ := do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope": first, "updatedAt": updatedAt, "deviceId": "d1", "baseRevision": nil,
	}, token); status != 200 {
		t.Fatalf("首次写入应成功")
	}

	// 正确 baseRevision 应成功,revision 递增
	status, body := do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope": map[string]any{"v": 1, "ct": "bbbb"}, "updatedAt": updatedAt + 1,
		"deviceId": "d1", "baseRevision": 1,
	}, token)
	if status != 200 {
		t.Fatalf("baseRevision=1 应成功, 得到 %d: %v", status, body)
	}
	if revision, _ := body["revision"].(float64); revision != 2 {
		t.Fatalf("revision 应递增到 2, 得到 %v", body["revision"])
	}

	// 过期的 baseRevision 必须冲突
	second := map[string]any{"v": 1, "ct": "cccc"}
	status, body = do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope": second, "updatedAt": updatedAt + 2, "deviceId": "d2", "baseRevision": 1,
	}, token)
	if status != http.StatusConflict {
		t.Fatalf("过期 baseRevision 应返回 409, 得到 %d: %v", status, body)
	}
	if body["ok"] != false {
		t.Fatalf("冲突响应 ok 应为 false: %v", body)
	}
	// 冲突时必须回传当前记录,客户端靠它合并
	conflict, _ := body["conflict"].(map[string]any)
	if conflict == nil {
		t.Fatal("冲突响应必须包含 conflict 记录, 否则客户端无法合并")
	}
	envelope, _ := conflict["envelope"].(map[string]any)
	if envelope["ct"] != "bbbb" {
		t.Fatalf("conflict 应是服务端当前版本(ct=bbbb), 得到 %v", envelope)
	}

	// 关键:冲突不能覆盖任何数据
	_, body = do(t, srv, "GET", "/api/v1/vault", nil, token)
	record, _ := body["record"].(map[string]any)
	got, _ := record["envelope"].(map[string]any)
	if got["ct"] != "bbbb" {
		t.Fatalf("冲突后数据被覆盖了!当前 ct=%v", got["ct"])
	}
	if revision, _ := record["revision"].(float64); revision != 2 {
		t.Fatalf("冲突后 revision 不应变化, 得到 %v", record["revision"])
	}
}

// TestConcurrentPushOnlyOneWins 验证并发写的正确性。
//
// TypeScript 版是"先 get 再条件 update"两步操作,存在 TOCTOU 窗口:
// 两个并发请求都读到 revision=1、都通过检查,后写的静默覆盖先写的——
// 那就是丢数据。Go 版用事务内的单条 SQL 判定,从根上消除该竞态。
func TestConcurrentPushOnlyOneWins(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "erin", "valid-password-99")
	updatedAt := time.Now().UnixMilli()

	// 建立 revision=1
	do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope":  map[string]any{"v": 1, "ct": "initial"},
		"updatedAt": updatedAt, "deviceId": "seed", "baseRevision": nil,
	}, token)

	const racers = 8
	type outcome struct {
		status int
		body   map[string]any
	}
	results := make(chan outcome, racers)
	start := make(chan struct{})

	for i := 0; i < racers; i++ {
		go func(n int) {
			<-start // 尽量让所有请求同时发出
			status, body := do(t, srv, "PUT", "/api/v1/vault", map[string]any{
				"envelope":     map[string]any{"v": 1, "ct": "racer-" + string(rune('A'+n))},
				"updatedAt":    updatedAt + int64(n),
				"deviceId":     "racer",
				"baseRevision": 1, // 全部基于同一个版本号
			}, token)
			results <- outcome{status, body}
		}(i)
	}
	close(start)

	success, conflict := 0, 0
	for i := 0; i < racers; i++ {
		got := <-results
		switch got.status {
		case 200:
			success++
		case 409:
			conflict++
		default:
			t.Errorf("并发推送出现意外状态码 %d: %v", got.status, got.body)
		}
	}

	// 核心断言:只能有一个赢家。若多个 200,说明发生了静默覆盖,
	// 后写的数据把先写的数据吃掉了。
	if success != 1 {
		t.Fatalf("并发写入应恰好一个成功, 实际 %d 个成功 %d 个冲突——存在静默覆盖", success, conflict)
	}
	if conflict != racers-1 {
		t.Fatalf("其余 %d 个都应返回 409", racers-1)
	}

	// 最终版本必须是 2
	_, body := do(t, srv, "GET", "/api/v1/vault", nil, token)
	record, _ := body["record"].(map[string]any)
	if revision, _ := record["revision"].(float64); revision != 2 {
		t.Fatalf("最终 revision 应为 2, 得到 %v", record["revision"])
	}
}

func TestFirstPushWithRevisionFails(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "frank", "valid-password-99")

	// 记录不存在却带了 baseRevision:属于冲突,不该凭空创建
	status, _ := do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope": map[string]any{"v": 1}, "updatedAt": time.Now().UnixMilli(),
		"deviceId": "d", "baseRevision": 5,
	}, token)
	if status != http.StatusConflict {
		t.Fatalf("不存在记录带baseRevision 应返回 409, 得到 %d", status)
	}

	// 确认没有真的写进去
	_, body := do(t, srv, "GET", "/api/v1/vault", nil, token)
	if body["record"] != nil {
		t.Fatalf("冲突的请求不应写入数据: %v", body["record"])
	}
}

func TestCORS(t *testing.T) {
	srv, _ := newTestServer(t)

	t.Run("白名单内来源被放行", func(t *testing.T) {
		req, _ := http.NewRequest("GET", srv.URL+"/health", nil)
		req.Header.Set("Origin", "https://2fa.example.com")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		defer resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://2fa.example.com" {
			t.Fatalf("白名单来源应被回显, 得到 %q", got)
		}
		// Vary 必须有,否则 CDN 会把响应串给其他来源。
		if !strings.Contains(resp.Header.Get("Vary"), "Origin") {
			t.Fatalf("缺少 Vary: Origin, 会导致 CDN 串源: %q", resp.Header.Get("Vary"))
		}
	})

	t.Run("白名单外来源不被回显", func(t *testing.T) {
		req, _ := http.NewRequest("GET", srv.URL+"/health", nil)
		req.Header.Set("Origin", "https://evil.example.com")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("请求失败: %v", err)
		}
		defer resp.Body.Close()
		if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "" {
			t.Fatalf("非白名单来源不应回显 ACAO, 得到 %q", got)
		}
	})
}

func TestSecurityHeaders(t *testing.T) {
	srv, _ := newTestServer(t)

	resp, err := http.Get(srv.URL + "/health")
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()

	expect := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "no-referrer",
		// 禁止缓存:避免密文被中间层留存
		"Cache-Control": "no-store",
	}
	for header, want := range expect {
		if got := resp.Header.Get(header); got != want {
			t.Errorf("安全头 %s 应为 %q, 得到 %q", header, want, got)
		}
	}
}

func TestUnknownEndpointReturns404(t *testing.T) {
	srv, _ := newTestServer(t)
	status, _ := do(t, srv, "GET", "/api/v1/does-not-exist", nil, "")
	if status != http.StatusNotFound {
		t.Fatalf("未知端点应返回 404, 得到 %d", status)
	}
}

func TestSyncLogOnlyMetadata(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "grace", "valid-password-99")
	updatedAt := time.Now().UnixMilli()

	do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope":  map[string]any{"v": 1, "ct": "secret-ciphertext"},
		"updatedAt": updatedAt, "deviceId": "device-x", "baseRevision": nil,
	}, token)

	_, body := do(t, srv, "GET", "/api/v1/sync-log", nil, token)
	raw, _ := json.Marshal(body)
	// 同步日志绝不能包含密文内容,否则服务端就成了泄漏点。
	if strings.Contains(string(raw), "secret-ciphertext") {
		t.Fatalf("同步日志泄漏了密文内容: %s", string(raw))
	}
	if !strings.Contains(string(raw), "device-x") {
		t.Fatalf("同步日志应包含设备元数据: %s", string(raw))
	}
}

func TestRefreshFlow(t *testing.T) {
	srv, _ := newTestServer(t)

	_, body := do(t, srv, "POST", "/api/v1/auth/register", map[string]any{
		"userId": "heidi", "password": "valid-password-99",
	}, "")
	refresh, _ := body["refreshToken"].(string)

	// 刷新成功
	status, refreshed := do(t, srv, "POST", "/api/v1/auth/refresh", map[string]any{
		"userId": "heidi", "refreshToken": refresh,
	}, "")
	if status != 200 {
		t.Fatalf("刷新应返回 200, 得到 %d: %v", status, refreshed)
	}
	newRefresh, _ := refreshed["refreshToken"].(string)
	if newRefresh == "" || newRefresh == refresh {
		t.Fatalf("刷新应返回新的刷新令牌: %v", refreshed)
	}

	// 新令牌可用
	newAccess, _ := refreshed["accessToken"].(string)
	if status, _ := do(t, srv, "GET", "/api/v1/vault", nil, newAccess); status != 200 {
		t.Fatalf("刷新后的访问令牌应可用, 得到 %d", status)
	}

	// 旧令牌一次性消耗
	if status, _ := do(t, srv, "POST", "/api/v1/auth/refresh", map[string]any{
		"userId": "heidi", "refreshToken": refresh,
	}, ""); status != http.StatusUnauthorized {
		t.Fatalf("旧刷新令牌应失效, 得到 %d", status)
	}
}

func TestBadJSONRejected(t *testing.T) {
	srv, _ := newTestServer(t)

	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/auth/login", strings.NewReader("{not json"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("非法 JSON 应返回 400, 得到 %d", resp.StatusCode)
	}
}

func TestMissingFieldsRejected(t *testing.T) {
	srv, _ := newTestServer(t)

	cases := []struct {
		name string
		path string
		body map[string]any
	}{
		{"注册缺 password", "/api/v1/auth/register", map[string]any{"userId": "x"}},
		{"注册缺 userId", "/api/v1/auth/register", map[string]any{"password": "valid-password-99"}},
		{"登录缺字段", "/api/v1/auth/login", map[string]any{"userId": "x"}},
		{"刷新缺 token", "/api/v1/auth/refresh", map[string]any{"userId": "x"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if status, _ := do(t, srv, "POST", tc.path, tc.body, ""); status != http.StatusBadRequest {
				t.Fatalf("应返回 400, 得到 %d", status)
			}
		})
	}
}

func TestOversizedBodyRejected(t *testing.T) {
	srv, _ := newTestServer(t)

	huge := strings.Repeat("A", maxBodyBytes+1024)
	req, _ := http.NewRequest("PUT", srv.URL+"/api/v1/vault", strings.NewReader(huge))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer whatever")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// 更大的请求可能被服务端直接断开连接,也是合理的拒绝方式。
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("超大请求体不应被接受")
	}
}

func TestNoStackTraceLeaked(t *testing.T) {
	srv, _ := newTestServer(t)
	// 传入类型错误的字段,触发服务端内部处理路径。
	status, body := do(t, srv, "PUT", "/api/v1/vault", map[string]any{
		"envelope": "not-an-object", "updatedAt": "not-a-number",
		"deviceId": "d", "baseRevision": nil,
	}, registerAndLogin(t, srv, "ivan", "valid-password-99"))

	raw, _ := json.Marshal(body)
	// Go 的 panic 会带上文件路径与行号,这些绝不能出现在响应里。
	for _, leak := range []string{"goroutine", ".go:", "panic", "runtime."} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("响应泄漏了内部细节 %q: %s", leak, string(raw))
		}
	}
	if status >= 500 {
		t.Logf("返回了 %d,但响应体没有栈信息,符合预期", status)
	}
}

func TestConcurrentSameUserPushes(t *testing.T) {
	srv, _ := newTestServer(t)
	token := registerAndLogin(t, srv, "judy", "valid-password-99")
	updatedAt := time.Now().UnixMilli()

	// 冷启动并发:所有请求都声称"我要创建"(baseRevision=nil)。
	// 有且只有一个人能创建成功,其余收到冲突。
	const workers = 6
	results := make(chan int, workers)
	for i := 0; i < workers; i++ {
		go func(n int) {
			status, _ := do(t, srv, "PUT", "/api/v1/vault", map[string]any{
				"envelope":     map[string]any{"v": 1, "n": n},
				"updatedAt":    updatedAt,
				"deviceId":     "worker",
				"baseRevision": nil,
			}, token)
			results <- status
		}(i)
	}

	success := 0
	for i := 0; i < workers; i++ {
		switch <-results {
		case 200:
			success++
		case 409:
		default:
			t.Errorf("出现意外状态码")
		}
	}
	if success != 1 {
		t.Fatalf("并发创建应恰好一个成功, 实际 %d 个", success)
	}
}

// TestTokenSecretRotation 验证密钥轮换的影响面。
//
// 轮换 tokenSecret 后所有旧访问令牌立即失效,但数据与刷新令牌不受影响——
// 因为密文不依赖它。这决定了运维怎么做轮换。
func TestTokenSecretRotation(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "credentials.json")

	oldSecret := "old-secret-at-least-32-characters-long"
	newSecret := "new-secret-at-least-32-characters-long"

	first, err := auth.New(file, oldSecret)
	if err != nil {
		t.Fatalf("创建服务失败: %v", err)
	}
	if _, err := first.Register("kim", "valid-password-99"); err != nil {
		t.Fatalf("注册失败: %v", err)
	}
	oldToken := first.IssueAccessToken("kim", "web", time.Hour)
	refresh, _ := first.IssueRefreshToken("kim")

	rotated, err := auth.New(file, newSecret)
	if err != nil {
		t.Fatalf("轮换后加载失败: %v", err)
	}
	if _, err := rotated.VerifyAccessToken(oldToken); err == nil {
		t.Fatal("轮换后旧访问令牌应立即失效")
	}
	// 刷新令牌不走签名,只比哈希,故不受轮换影响。
	if _, err := rotated.Refresh("kim", refresh); err != nil {
		t.Fatalf("轮换不应影响刷新令牌: %v", err)
	}
}

func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
