// Package httpapi 实现 HTTP 路由、CORS、限流与错误响应。
//
// 安全要点:
//
//   - CORS 使用显式来源白名单,生产环境禁止通配符。
//   - 访问令牌只从 Authorization 头提取,绝不放URL 查询参数
//     (URL 会被浏览器历史、Referer、访问日志记录)。
//   - 统一 JSON 错误结构,不返回堆栈。
//   - 基础限流,防止撞库。
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"twofa/server/internal/auth"
	"twofa/server/internal/config"
	"twofa/server/internal/store"
)

// maxBodyBytes 是请求体上限。保险库密文远小于此,2MB 足够宽裕。
const maxBodyBytes = 2 * 1024 * 1024

// Server 持有路由与依赖。
type Server struct {
	cfg     *config.Config
	auth    *auth.Service
	repo    *store.Repository
	log     *slog.Logger
	limiter *rateLimiter
	// startedAt 用于 /health 的 uptime。
	startedAt time.Time
}

// New 构造服务。
func New(cfg *config.Config, authSvc *auth.Service, repo *store.Repository, log *slog.Logger) *Server {
	return &Server{
		cfg:       cfg,
		auth:      authSvc,
		repo:      repo,
		log:       log,
		limiter:   newRateLimiter(),
		startedAt: time.Now(),
	}
}

// Handler 返回可直接挂载的 handler。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Go 1.22 的 ServeMux 支持方法级路由,省去手写分发。
	// 精确匹配("/api/v1/vault" 不带尾斜杠)不会误匹配子路径。
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("GET /ready", s.handleReady)
	mux.HandleFunc("POST /api/v1/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/refresh", s.handleRefresh)
	mux.HandleFunc("GET /api/v1/vault", s.handlePull)
	mux.HandleFunc("PUT /api/v1/vault", s.handlePush)
	mux.HandleFunc("GET /api/v1/sync-log", s.handleSyncLog)

	// 兜底:未被上面任何模式匹配的请求。
	//
	// 不加这个,Go 的 ServeMux 会返回纯文本 "404 page not found",
	// 客户端 JSON 解析直接失败。统一成 JSON 错误结构后,
	// 客户端拿到的形状与业务错误一致,能正确处理。
	//
	// 实测(Go 1.26)确认:注册了 "/" 之后,路径存在但方法不匹配的请求
	// 也会落到这里,而不是返回 405。所以这个 handler 覆盖了全部未匹配情况。
	// 这比试图区分 404/405 更简单,也更符合前端预期——客户端只需要知道
	// "这个端点不可用",不需要精确的错误码。
	mux.HandleFunc("/", s.handleFallback)

	return s.withHeaders(mux)
}

// handleFallback 处理所有未被显式注册的请求。
func (s *Server) handleFallback(w http.ResponseWriter, _ *http.Request) {
	writeError(w, http.StatusNotFound, "NOT_FOUND", "端点不存在或请求方法不被支持")
}

// withHeaders 统一施加 CORS 与安全响应头。
func (s *Server) withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			// 必须带 Vary: Origin,否则 CDN 会把某个来源的响应
			// 缓存后发给其他来源,等于绕过白名单。
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type")
			w.Header().Set("Access-Control-Max-Age", "600")
		}

		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// 本服务只返回 JSON,禁止任何形式的缓存,避免密文被中间层留存。
		w.Header().Set("Cache-Control", "no-store")

		// 预检请求直接返回:Go 的 ServeMux 不会自动处理 OPTIONS。
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	for _, allowed := range s.cfg.AllowedOrigins {
		if allowed == origin {
			return true
		}
	}
	return false
}

// ---- 响应工具 ----

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeJSON 输出 JSON 响应。
func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	// 编码失败时已无法改状态码,忽略:body 都是简单结构。
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, errorBody{Error: errorDetail{Code: code, Message: message}})
}

// readJSON 读取并解析请求体,带大小上限。
func readJSON(r *http.Request, dst any) error {
	// MaxBytesReader 在读取超限时直接报错,且会关闭连接,
	// 不需要像手工实现那样自己数字节。
	body := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	raw, err := io.ReadAll(body)
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errors.New("请求体过大")
		}
		return errors.New("读取请求体失败")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return errors.New("请求体不是合法 JSON")
	}
	return nil
}

// authenticate 从 Authorization 头提取并校验令牌。
//
// URL 里的 access_token 参数一律不采信。
func (s *Server) authenticate(r *http.Request) (*auth.AccessToken, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return nil, false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if token == "" {
		return nil, false
	}
	identity, err := s.auth.VerifyAccessToken(token)
	if err != nil {
		return nil, false
	}
	return identity, true
}

// clientKey 取用于限流的客户端标识。
//
// 信任 X-Forwarded-For 的第一个值——它代表最靠近客户端的那一跳,
// 也就是实际的客户端 IP(nginx 的 $proxy_add_x_forwarded_for 头部
// 第一个元素是它,后续是逐级代理追加的)。
func clientKey(r *http.Request) string {
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		first := strings.TrimSpace(strings.Split(forwarded, ",")[0])
		if first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- 端点 ----

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"uptime": int(time.Since(s.startedAt).Seconds()),
	})
}

func (s *Server) handleReady(w http.ResponseWriter, r *http.Request) {
	// 真正检查依赖:能查到库说明 SQLite 可用。
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	if err := s.repo.Ping(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "STORAGE_UNAVAILABLE", "存储不可用")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "storage": "ok"})
}

type registerRequest struct {
	UserID   string `json:"userId"`
	Password string `json:"password"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("register:"+clientKey(r), 5, time.Hour) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "注册过于频繁,请稍后再试")
		return
	}

	var body registerRequest
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if body.UserID == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "缺少 userId 或 password")
		return
	}

	userID, err := s.auth.Register(body.UserID, body.Password)
	switch {
	case errors.Is(err, auth.ErrUserExists):
		writeError(w, http.StatusConflict, "ALREADY_EXISTS", "该账户已存在,请直接登录")
		return
	case errors.Is(err, auth.ErrInvalidUserID):
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "账户标识不合法")
		return
	case errors.Is(err, auth.ErrWeakPassword):
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "登录密码至少 8 位")
		return
	case err != nil:
		s.log.Error("注册失败", "userId", body.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	refresh, err := s.auth.IssueRefreshToken(userID)
	if err != nil {
		s.log.Error("签发刷新令牌失败", "userId", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	s.log.Info("新用户注册", "userId", userID)
	writeJSON(w, http.StatusCreated, map[string]any{
		"userId":       userID,
		"accessToken":  s.auth.IssueAccessToken(userID, "initial", s.cfg.AccessTokenTTL),
		"refreshToken": refresh,
		"expiresIn":    int(s.cfg.AccessTokenTTL.Seconds()),
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow("login:"+clientKey(r), 10, 15*time.Minute) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过多,请稍后再试")
		return
	}

	var body registerRequest
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if body.UserID == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "缺少 userId 或 password")
		return
	}

	if err := s.auth.Verify(body.UserID, body.Password); err != nil {
		// 不区分"用户不存在"与"密码错误",避免账户枚举。
		s.log.Warn("登录失败", "userId", body.UserID)
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", "账户或密码错误")
		return
	}

	userID := strings.TrimSpace(body.UserID)
	refresh, err := s.auth.IssueRefreshToken(userID)
	if err != nil {
		s.log.Error("签发刷新令牌失败", "userId", userID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"userId":       userID,
		"accessToken":  s.auth.IssueAccessToken(userID, "login", s.cfg.AccessTokenTTL),
		"refreshToken": refresh,
		"expiresIn":    int(s.cfg.AccessTokenTTL.Seconds()),
	})
}

type refreshRequest struct {
	UserID       string `json:"userId"`
	RefreshToken string `json:"refreshToken"`
}

func (s *Server) handleRefresh(w http.ResponseWriter, r *http.Request) {
	var body refreshRequest
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if body.UserID == "" || body.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "缺少 userId 或 refreshToken")
		return
	}

	pair, err := s.auth.Refresh(body.UserID, body.RefreshToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "INVALID_REFRESH_TOKEN", "登录已过期,请重新登录")
		return
	}
	// refresh 内部按默认 TTL 签发,这里用配置值重新签发一次访问令牌,
	// 保证与登录时的有效期一致。
	writeJSON(w, http.StatusOK, map[string]any{
		"accessToken":  s.auth.IssueAccessToken(strings.TrimSpace(body.UserID), "refreshed", s.cfg.AccessTokenTTL),
		"refreshToken": pair.RefreshToken,
		"expiresIn":    int(s.cfg.AccessTokenTTL.Seconds()),
	})
}

// vaultRecord 是下发给客户端的记录形态。
type vaultRecord struct {
	Envelope  any    `json:"envelope"`
	Revision  int64  `json:"revision"`
	UpdatedAt int64  `json:"updatedAt"`
	DeviceID  string `json:"deviceId"`
}

func (s *Server) handlePull(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "请先登录")
		return
	}

	record, err := s.repo.Get(r.Context(), identity.UserID)
	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusOK, map[string]any{"record": nil})
		return
	}
	if err != nil {
		s.log.Error("拉取保险库失败", "userId", identity.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	// Envelope 以原始 JSON 透传。服务端不解析它——
	// 结构由客户端的 schemaVersion 负责,服务端无从也无权解读。
	var envelope any
	if err := json.Unmarshal([]byte(record.Envelope), &envelope); err != nil {
		// 库里存的不是合法 JSON 说明数据被外部破坏了,如实报错,
		// 不要返回空对象假装成功——那会让客户端用空保险库覆盖云端。
		s.log.Error("保险库记录格式损坏", "userId", identity.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "CORRUPT_RECORD", "云端数据已损坏")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"record": vaultRecord{
			Envelope:  envelope,
			Revision:  record.Revision,
			UpdatedAt: record.UpdatedAt,
			DeviceID:  record.DeviceID,
		},
	})
}

type pushRequest struct {
	Envelope     any    `json:"envelope"`
	UpdatedAt    *int64 `json:"updatedAt"`
	DeviceID     string `json:"deviceId"`
	BaseRevision *int64 `json:"baseRevision"`
}

func (s *Server) handlePush(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "请先登录")
		return
	}

	if !s.limiter.allow("push:"+identity.UserID, 60, time.Minute) {
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", "同步过于频繁")
		return
	}

	var body pushRequest
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error())
		return
	}
	if body.Envelope == nil || body.UpdatedAt == nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "缺少 envelope 或 updatedAt")
		return
	}

	// 重新序列化而不是复用原始 body:保证存进库的一定是规范化 JSON,
	// 避免客户端送来畸形结构被原样持久化。
	envelopeJSON, err := json.Marshal(body.Envelope)
	if err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", "envelope 不是合法 JSON")
		return
	}

	deviceID := body.DeviceID
	if deviceID == "" {
		deviceID = "unknown"
	}
	// 限制长度,防止超长字段把库撑大。
	if len(deviceID) > 64 {
		deviceID = deviceID[:64]
	}

	revision, err := s.repo.Put(
		r.Context(), identity.UserID, string(envelopeJSON), *body.UpdatedAt, deviceID, body.BaseRevision,
	)

	if err == nil {
		s.log.Info("同步上传成功",
			"userId", identity.UserID,
			"revision", revision,
			"bytes", len(envelopeJSON))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revision": revision})
		return
	}

	if !errors.Is(err, store.ErrConflict) {
		s.log.Error("写入保险库失败", "userId", identity.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	// 冲突:返回当前记录,让客户端合并后重试。绝不静默覆盖。
	//
	// 隐式契约:客户端 core 的 httpTransport 用 /服务端返回 409/ 判断冲突,
	// 改成别的状态码会让客户端当成普通错误抛出去,同步静默失效。
	current, getErr := s.repo.Get(r.Context(), identity.UserID)
	if getErr != nil && !errors.Is(getErr, store.ErrNotFound) {
		s.log.Error("读取冲突记录失败", "userId", identity.UserID, "error", getErr)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}

	var conflict any
	if current != nil {
		var envelope any
		if err := json.Unmarshal([]byte(current.Envelope), &envelope); err == nil {
			conflict = vaultRecord{
				Envelope:  envelope,
				Revision:  current.Revision,
				UpdatedAt: current.UpdatedAt,
				DeviceID:  current.DeviceID,
			}
		}
	}

	s.log.Warn("同步冲突", "userId", identity.UserID)
	writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "conflict": conflict})
}

func (s *Server) handleSyncLog(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.authenticate(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "请先登录")
		return
	}
	// 只返回元数据(设备、版本、时间、字节数),不含任何内容。
	entries, err := s.repo.RecentSyncs(r.Context(), identity.UserID, 20)
	if err != nil {
		s.log.Error("查询同步日志失败", "userId", identity.UserID, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务器内部错误")
		return
	}
	if entries == nil {
		entries = []store.SyncEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"syncs": entries})
}

// ---- 限流 ----

// rateLimitEntry 是单个键的计数。
type rateLimitEntry struct {
	count   int
	resetAt time.Time
}

// rateLimiter 是内存计数限流器。
//
// 注意这是单进程实现:多实例部署时每个实例各算各的,总阈值会被放大。
// 本服务设计上是单实例(单机SQLite),若要横向扩展需换成 Redis 之类
// 的共享计数器。
type rateLimiter struct {
	mu      sync.Mutex
	entries map[string]rateLimitEntry
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{entries: make(map[string]rateLimitEntry)}
}

// allow 记录一次访问,返回是否在阈值内。
func (rl *rateLimiter) allow(key string, limit int, window time.Duration) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	entry, ok := rl.entries[key]
	if !ok || now.After(entry.resetAt) {
		rl.entries[key] = rateLimitEntry{count: 1, resetAt: now.Add(window)}
		return true
	}
	entry.count++
	rl.entries[key] = entry
	return entry.count <= limit
}
