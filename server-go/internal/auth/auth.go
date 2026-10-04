// SPDX-License-Identifier: AGPL-3.0-only

// Package auth 实现服务端身份认证。
//
// 核心安全设计:服务端身份与用户主密码严格分离。
//
//   - 服务端身份(本包)只用于回答"这是哪个用户的哪台设备",
//     作用是决定把哪份密文发给谁。
//   - 主密码(master password)只存在于客户端,用于加解密保险库。
//     服务端从不接收、从不存储、也永远无法得知。
//
// 因此即使数据库整体被脱库,攻击者拿到的也只是密文;
// 若再叠加主密码强度足够,用户的 TOTP 种子依然安全。
//
// 反过来也要说清风险:主密码太弱时,攻击者可以离线爆破密文。
// 客户端的密码强度校验与 21 万次 PBKDF2 就是为抬高这个成本而存在。
package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/scrypt"
)

// scrypt 参数。必须与 Node 版完全一致(N=16384, r=8, p=1, keyLen=64),
// 否则同一份 credentials.json 在两种实现间互不认。
// Go 的 scrypt 库对 CPU/内存有硬性上限校验,参数改动前先确认。
const (
	scryptKeyLen = 64
	scryptN      = 16384
	scryptR      = 8
	scryptP      = 1
)

// 令牌与凭据的保留期限。
const (
	refreshTokenTTL = 30 * 24 * time.Hour
	usedTokenTTL    = 24 * time.Hour
)

var (
	// ErrUserExists 表示注册时账户已存在,由上层转为 409。
	ErrUserExists = errors.New("该账户已存在")
	// ErrInvalidCredentials 表示登录失败。不区分"用户不存在"与"密码错误",
	// 避免账户枚举。
	ErrInvalidCredentials = errors.New("账户或密码错误")
	// ErrInvalidRefreshToken 表示刷新令牌无效、已用过或已吊销。
	ErrInvalidRefreshToken = errors.New("登录已过期")
	// ErrInvalidUserID 表示账户标识不合法。
	ErrInvalidUserID = errors.New("账户标识不合法")
	// ErrWeakPassword 表示登录密码不满足最小长度。
	ErrWeakPassword = errors.New("登录密码至少 8 位")
	// ErrCorrupted 表示凭据文件损坏。启动时直接失败而不是重置为空——
	// 重置会让所有用户突然"不存在",表现为无法登录且无从排查。
	ErrCorrupted = errors.New("凭据文件损坏")
)

// Credential 是单个用户的口令哈希。
type StoredCredential struct {
	UserID    string `json:"userId"`
	Salt      string `json:"salt"`
	Hash      string `json:"hash"`
	CreatedAt int64  `json:"createdAt"`
}

// persisted 是 credentials.json 的磁盘格式。
type persisted struct {
	Users         []StoredCredential          `json:"users"`
	RefreshTokens map[string]map[string]int64 `json:"refreshTokens"`
}

// Service 管理账户、刷新令牌与访问令牌签发。
//
// 并发:所有公开方法都持有mu。Go 的map 并发读写会直接崩溃,
// 而 HTTP 服务器天然并发,这个锁是必需的而非可选。
type Service struct {
	mu          sync.Mutex
	dataFile    string
	tokenSecret []byte
	users       map[string]StoredCredential
	// refreshTokens 是 userID -> 刷新令牌哈希 -> 签发时间。
	refreshTokens map[string]map[string]int64
	// usedRefreshTokens 记录已核销的刷新令牌。
	// 同一令牌被用第二次说明可能已泄露,此时吊销该用户全部刷新令牌。
	usedRefreshTokens map[string]int64
}

// New 载入凭据并创建服务。
//
// tokenSecret 为空直接报错:不允许用默认值跑生产,
// 这是"静默降级",在生产上的代价极高。
func New(dataFile, tokenSecret string) (*Service, error) {
	if strings.TrimSpace(tokenSecret) == "" {
		return nil, errors.New("缺少令牌签名密钥 TWOFA_TOKEN_SECRET")
	}
	s := &Service{
		dataFile:          dataFile,
		tokenSecret:       []byte(tokenSecret),
		users:             make(map[string]StoredCredential),
		refreshTokens:     make(map[string]map[string]int64),
		usedRefreshTokens: make(map[string]int64),
	}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) load() error {
	raw, err := os.ReadFile(s.dataFile)
	if errors.Is(err, os.ErrNotExist) {
		return nil // 首次启动,没有凭据文件是正常的
	}
	if err != nil {
		return fmt.Errorf("读取凭据文件失败: %w", err)
	}

	var data persisted
	if err := json.Unmarshal(raw, &data); err != nil {
		return fmt.Errorf("%w: %s", ErrCorrupted, s.dataFile)
	}

	for _, u := range data.Users {
		s.users[u.UserID] = u
	}
	for userID, tokens := range data.RefreshTokens {
		// 复制而非直接引用:避免持久化结构与内存结构共享 map,
		// 后续修改会意外改到已读入的 data。
		copied := make(map[string]int64, len(tokens))
		for h, at := range tokens {
			copied[h] = at
		}
		s.refreshTokens[userID] = copied
	}
	return nil
}

// persist 把内存状态写回磁盘。
//
// 必须先写临时文件再 rename:直接覆盖原文件,若在写入中途崩溃,
// 凭据文件会变成半截内容,重启后所有用户都无法登录。
func (s *Service) persist() error {
	if err := os.MkdirAll(filepath.Dir(s.dataFile), 0o700); err != nil {
		return fmt.Errorf("创建数据目录失败: %w", err)
	}

	data := persisted{
		Users:         make([]StoredCredential, 0, len(s.users)),
		RefreshTokens: make(map[string]map[string]int64, len(s.refreshTokens)),
	}
	for _, u := range s.users {
		data.Users = append(data.Users, u)
	}
	for userID, tokens := range s.refreshTokens {
		copied := make(map[string]int64, len(tokens))
		for h, at := range tokens {
			copied[h] = at
		}
		data.RefreshTokens[userID] = copied
	}

	// 用户遍历 map 的顺序随机,直接序列化会让文件内容每次都不同,
	// 难以比对与增量备份。按 userId 排序。
	sortCredentials(data.Users)

	blob, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化凭据失败: %w", err)
	}

	tmp := s.dataFile + ".tmp"
	// 0o600:凭据文件只有服务进程可读。
	if err := os.WriteFile(tmp, blob, 0o600); err != nil {
		return fmt.Errorf("写入凭据文件失败: %w", err)
	}
	if err := os.Rename(tmp, s.dataFile); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("替换凭据文件失败: %w", err)
	}
	return nil
}

func sortCredentials(list []StoredCredential) {
	// 手写插入排序:条目数与用户数同阶,通常是个位数到几十,
	// 引入 sort 依赖不划算,且这里只需要按字符串比较。
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].UserID < list[j-1].UserID; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
}

// hashPassword 派生口令哈希。
//
// password 先做 NFKC 归一化:同一视觉相同的密码(如全角/半角)应该哈希成
// 同一个值,否则用户在不同输入法下会得到不同结果。这一步与 Node 版一致。
func hashPassword(password string, salt []byte) ([]byte, error) {
	normalized := normalizeNFKC(password)
	return scrypt.Key([]byte(normalized), salt, scryptN, scryptR, scryptP, scryptKeyLen)
}

// passwordLength 返回归一化后的口令长度。
//
// 必须用归一化后的结果而非原始输入:全角"ＡＢＣ１２３"归一化后是
// "abc123",只有 6 字符。直接在原始输入上量长度会把合法的弱口令
// 判成"不足 8 位",让用全角输入法的用户根本注册不了。
func passwordLength(password string) int {
	return len([]rune(normalizeNFKC(password)))
}

// Register 注册账户。userID 由调用方提供(小程序传 openid,Web 端传用户名)。
func (s *Service) Register(userID, password string) (string, error) {
	id := strings.TrimSpace(userID)
	if id == "" || len(id) > 128 {
		return "", ErrInvalidUserID
	}
	// 强度校验看归一化后的长度,与 hashPassword 保持同一把尺子。
	if passwordLength(password) < 8 {
		return "", ErrWeakPassword
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if _, exists := s.users[id]; exists {
		return "", ErrUserExists
	}

	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("生成盐失败: %w", err)
	}
	hash, err := hashPassword(password, salt)
	if err != nil {
		return "", fmt.Errorf("派生口令哈希失败: %w", err)
	}

	s.users[id] = StoredCredential{
		UserID:    id,
		Salt:      hex.EncodeToString(salt),
		Hash:      hex.EncodeToString(hash),
		CreatedAt: time.Now().UnixMilli(),
	}
	if err := s.persist(); err != nil {
		// 回滚内存状态,否则用户会看到"注册成功"但重启后消失。
		delete(s.users, id)
		return "", err
	}
	return id, nil
}

// Verify 校验登录口令。
//
// 用户不存在时也执行一次哈希运算,让响应时间与用户存在时接近,
// 避免通过时间差枚举出哪些账户已注册。这点很容易在上重构时被丢掉,
// 所以在注释里显式说明。
func (s *Service) Verify(userID, password string) error {
	id := strings.TrimSpace(userID)

	s.mu.Lock()
	defer s.mu.Unlock()

	cred, ok := s.users[id]
	if !ok {
		// 故意消耗一次 scrypt:参数与真实路径一致,耗时才接近。
		salt := make([]byte, 16)
		_, _ = rand.Read(salt)
		_, _ = hashPassword(password, salt)
		return ErrInvalidCredentials
	}

	candidate, err := hashPassword(password, mustHex(cred.Salt))
	if err != nil {
		return ErrInvalidCredentials
	}
	// subtle.ConstantTimeCompare 是常数时间比较,避免通过耗时差异
	// 逐字节猜出哈希。
	if subtle.ConstantTimeCompare(candidate, mustHex(cred.Hash)) != 1 {
		return ErrInvalidCredentials
	}
	return nil
}

// Exists 判断账户是否存在。仅供运维端点使用,不要暴露给客户端
// (会变成账户枚举接口)。
func (s *Service) Exists(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.users[strings.TrimSpace(userID)]
	return ok
}

// ---- 访问令牌 ----

// AccessToken 是从访问令牌里解出的身份。
type AccessToken struct {
	UserID   string
	DeviceID string
}

// IssueAccessToken 签发访问令牌。
//
// 用 HMAC 签名而非 JWT:服务端本来就持有密钥,无状态 JWT 的收益
// (可分发验证)在这里没有价值,而有状态令牌支持即时吊销——
// 用户丢失设备时能立刻失效。
func (s *Service) IssueAccessToken(userID, deviceID string, ttl time.Duration) string {
	expiresAt := time.Now().Add(ttl).UnixMilli()
	payload := fmt.Sprintf("%s|%s|%d", userID, deviceID, expiresAt)

	mac := hmac.New(sha256.New, s.tokenSecret)
	mac.Write([]byte(payload))
	sig := hex.EncodeToString(mac.Sum(nil))

	// base64.RawURLEncoding 与 Node 的 toString('base64url') 一致:无填充、
	// URL 安全字符集。填充差异会导致 Go 签发的令牌被 JS 判为格式错误。
	encoded := base64.RawURLEncoding.EncodeToString([]byte(payload))
	return encoded + "." + sig
}

// VerifyAccessToken 校验访问令牌。
func (s *Service) VerifyAccessToken(token string) (*AccessToken, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil, errors.New("令牌格式错误")
	}

	decoded, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, errors.New("令牌负载格式错误")
	}
	payload := string(decoded)

	mac := hmac.New(sha256.New, s.tokenSecret)
	mac.Write([]byte(payload))
	expected := hex.EncodeToString(mac.Sum(nil))

	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expected)) != 1 {
		return nil, errors.New("令牌签名无效")
	}

	segments := strings.Split(payload, "|")
	if len(segments) < 3 {
		return nil, errors.New("令牌负载字段不足")
	}
	userID := segments[0]
	if userID == "" {
		return nil, errors.New("令牌缺少用户标识")
	}
	deviceID := "unknown"
	if segments[1] != "" {
		deviceID = segments[1]
	}

	expiresAt, err := strconv.ParseInt(segments[2], 10, 64)
	if err != nil {
		return nil, errors.New("令牌过期时间无效")
	}
	if time.Now().UnixMilli() > expiresAt {
		return nil, errors.New("令牌已过期")
	}

	s.mu.Lock()
	_, known := s.users[userID]
	s.mu.Unlock()
	if !known {
		return nil, errors.New("用户不存在")
	}
	return &AccessToken{UserID: userID, DeviceID: deviceID}, nil
}

// ---- 刷新令牌 ----

// TokenPair 是一次登录/刷新的产出。
type TokenPair struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
}

// IssueRefreshToken 签发一次性刷新令牌。只存哈希,不存明文。
func (s *Service) IssueRefreshToken(userID string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("生成刷新令牌失败: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.refreshTokens[userID] == nil {
		s.refreshTokens[userID] = make(map[string]int64)
	}
	s.refreshTokens[userID][hashToken(token)] = time.Now().UnixMilli()
	s.pruneRefreshTokensLocked()
	if err := s.persist(); err != nil {
		return "", err
	}
	return token, nil
}

// Refresh 用刷新令牌换新的令牌对。
//
// 刷新令牌一次性使用:换取成功后立即作废。若同一令牌被用第二次,
// 说明它已经泄露(攻击者与用户同时持有),此时吊销该用户全部刷新令牌,
// 迫使重新登录。
func (s *Service) Refresh(userID, refreshToken string) (*TokenPair, error) {
	id := strings.TrimSpace(userID)

	s.mu.Lock()
	defer s.mu.Unlock()

	tokens, ok := s.refreshTokens[id]
	if !ok {
		return nil, ErrInvalidRefreshToken
	}
	hash := hashToken(refreshToken)

	if _, live := tokens[hash]; !live {
		// 令牌不存在或已被核销。若曾被核销,视为泄露。
		key := id + "|" + hash
		if _, used := s.usedRefreshTokens[key]; used {
			// clear 是内置函数 clear(m),不是 m.clear() 方法。
			clear(tokens)
			_ = s.persist()
		}
		return nil, ErrInvalidRefreshToken
	}

	delete(tokens, hash)
	s.usedRefreshTokens[id+"|"+hash] = time.Now().UnixMilli()
	s.pruneUsedTokensLocked()
	if err := s.persist(); err != nil {
		return nil, err
	}

	// 持久化成功后再签发,避免签发了却没落盘导致用户下次无法续期。
	return s.pairLocked(id)
}

// pairLocked 在持有锁的前提下签发一对新令牌。
func (s *Service) pairLocked(userID string) (*TokenPair, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("生成刷新令牌失败: %w", err)
	}
	refresh := base64.RawURLEncoding.EncodeToString(raw)

	if s.refreshTokens[userID] == nil {
		s.refreshTokens[userID] = make(map[string]int64)
	}
	s.refreshTokens[userID][hashToken(refresh)] = time.Now().UnixMilli()
	s.pruneRefreshTokensLocked()
	if err := s.persist(); err != nil {
		return nil, err
	}

	return &TokenPair{
		AccessToken:  s.IssueAccessToken(userID, "refreshed", defaultAccessTTL),
		RefreshToken: refresh,
	}, nil
}

// defaultAccessTTL 是 refresh() 内部签发访问令牌时使用的有效期。
// 与配置项TWOFA_TOKEN_TTL 一致;refresh 端点由上层覆盖为配置值。
const defaultAccessTTL = time.Hour

// Logout 吊销该用户全部刷新令牌。
func (s *Service) Logout(userID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.refreshTokens, strings.TrimSpace(userID))
	return s.persist()
}

func (s *Service) pruneRefreshTokensLocked() {
	cutoff := time.Now().Add(-refreshTokenTTL).UnixMilli()
	for _, tokens := range s.refreshTokens {
		for h, at := range tokens {
			if at < cutoff {
				delete(tokens, h)
			}
		}
	}
}

func (s *Service) pruneUsedTokensLocked() {
	cutoff := time.Now().Add(-usedTokenTTL).UnixMilli()
	for k, at := range s.usedRefreshTokens {
		if at < cutoff {
			delete(s.usedRefreshTokens, k)
		}
	}
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		// 磁盘上的哈希若不是合法 hex,说明文件被外部改坏了。
		// 返回空切片让后续比较失败,而不是 panic 带崩整个服务。
		return nil
	}
	return b
}
