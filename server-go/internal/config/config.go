// SPDX-License-Identifier: AGPL-3.0-only

// Package config 负责读取与校验启动配置。
//
// 设计原则:启动即校验。缺失或使用弱默认值时直接退出,
// 而不是带着不安全的配置跑起来——这类"静默降级"在生产上代价极高。
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config 是服务的完整配置。
type Config struct {
	Port           int
	Host           string
	DataDir        string
	TokenSecret    string
	AllowedOrigins []string
	AccessTokenTTL time.Duration
	IsProduction   bool

	// DBDriver 是数据库类型:sqlite(本地开发/测试)或 postgres(实际部署)。
	DBDriver string
	// DatabaseURL 是 PostgreSQL 连接串。仅 DBDriver 为 postgres 时必填。
	DatabaseURL string
}

// 默认值。与 .env.example 保持一致。
const (
	defaultPort    = 8787
	defaultHost    = "127.0.0.1"
	defaultDataDir = "./server-go/data"
	defaultTTLSecs = 3600

	// devSecret 仅用于本地开发,生产环境会拒绝使用它。
	devSecret = "dev-only-insecure-secret-do-not-use-in-production"

	minSecretLength = 32
)

// defaultDBDriverFor 返回该环境下合适的默认数据库。
func defaultDBDriverFor(isProduction bool) string {
	if isProduction {
		return "postgres"
	}
	return "sqlite"
}

// Getenv 抽象出便于测试的环境变量读取。
type Getenv func(string) string

// Load 读取并校验配置。
//
// 返回错误时调用方必须直接退出——不要降级到"部分可用"的状态,
// 那意味着用户以为自己在安全配置下运行。
func Load(getenv Getenv) (*Config, error) {
	// 优先读 TWOFA_ENV(语义清晰),兼容 NODE_ENV。
	// 支持后者是因为同一份 .env 要能被 Node 版与 Go 版共用,
	// 迁移期间不必改环境变量名。
	isProduction := getenv("TWOFA_ENV") == "production" || getenv("NODE_ENV") == "production"

	tokenSecret := strings.TrimSpace(getenv("TWOFA_TOKEN_SECRET"))
	if tokenSecret == "" {
		if isProduction {
			return nil, fmt.Errorf(
				"生产环境必须设置 TWOFA_TOKEN_SECRET,生成方式: openssl rand -hex 32")
		}
		// 开发环境回退到固定值,但它必须在下面被生产校验拒绝。
		tokenSecret = devSecret
	}

	if isProduction {
		if tokenSecret == devSecret {
			return nil, fmt.Errorf("生产环境拒绝使用开发默认密钥")
		}
		if len(tokenSecret) < minSecretLength {
			return nil, fmt.Errorf("生产环境的 TWOFA_TOKEN_SECRET 至少需要 %d 个字符", minSecretLength)
		}
	}

	origins := splitAndTrim(getenv("TWOFA_ALLOWED_ORIGINS"))
	if len(origins) == 0 {
		origins = []string{"http://localhost:5173", "http://127.0.0.1:5173"}
	}
	if isProduction {
		for _, o := range origins {
			if o == "*" {
				return nil, fmt.Errorf("生产环境不允许 CORS 通配符 *,请配置具体来源")
			}
		}
		if !hasHTTPSOrigin(origins) {
			return nil, fmt.Errorf("生产环境的来源列表中没有任何 https:// 来源,请检查配置")
		}
	}

	port, err := strconv.Atoi(getenvDefault(getenv, "PORT", strconv.Itoa(defaultPort)))
	if err != nil {
		return nil, fmt.Errorf("PORT 必须是 1-65535 之间的数字")
	}
	if port < 1 || port > 65535 {
		return nil, fmt.Errorf("PORT 必须是 1-65535 之间的数字")
	}

	ttlSecs, err := strconv.Atoi(getenvDefault(getenv, "TWOFA_TOKEN_TTL", strconv.Itoa(defaultTTLSecs)))
	if err != nil || ttlSecs < 60 || ttlSecs > 30*24*3600 {
		return nil, fmt.Errorf("TWOFA_TOKEN_TTL 必须是 60 到 %d 秒之间的数字", 30*24*3600)
	}

	dataDir := getenvDefault(getenv, "TWOFA_DATA_DIR", defaultDataDir)
	absData, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("TWOFA_DATA_DIR 不是合法路径: %w", err)
	}

	// 数据库类型。
	//
	// 生产环境默认 PostgreSQL:SQLite 是单文件库,整库串行写,
	// 用户量上来或上多实例后必然成为瓶颈。
	// 开发与测试环境默认 SQLite:免装数据库,一条命令就能跑。
	//
	// 显式设置 TWOFA_DB_DRIVER 时始终以它为准——
	// 允许生产环境用 SQLite,因为"单机小规模部署"是真实存在的场景,
	// 不该由程序替用户做这个决定,只该把默认选对并给出警告。
	dbDriver := strings.ToLower(getenvDefault(getenv, "TWOFA_DB_DRIVER", defaultDBDriverFor(isProduction)))
	switch dbDriver {
	case "sqlite", "postgres":
	default:
		return nil, fmt.Errorf("TWOFA_DB_DRIVER 只能是 sqlite 或 postgres,得到 %q", dbDriver)
	}

	databaseURL := strings.TrimSpace(getenv("TWOFA_DATABASE_URL"))
	if dbDriver == "postgres" && databaseURL == "" {
		return nil, fmt.Errorf(
			"TWOFA_DB_DRIVER=postgres 时必须设置 TWOFA_DATABASE_URL," +
				"形如 postgres://user:pass@host:5432/twofa?sslmode=require")
	}
	if dbDriver == "sqlite" && isProduction && databaseURL != "" {
		// 不算错误,但几乎肯定是配错了——生产环境用 SQLite 等于放弃了并发能力。
		// 这里只提示,因为确实存在"单机小规模部署先用 SQLite"的合理场景。
		fmt.Fprintf(os.Stderr,
			"警告:检测到 TWOFA_DATABASE_URL 但 TWOFA_DB_DRIVER=sqlite,该连接串不会被使用\n")
	}

	return &Config{
		Port:           port,
		Host:           getenvDefault(getenv, "HOST", defaultHost),
		DataDir:        absData,
		TokenSecret:    tokenSecret,
		AllowedOrigins: origins,
		AccessTokenTTL: time.Duration(ttlSecs) * time.Second,
		IsProduction:   isProduction,
		DBDriver:       dbDriver,
		DatabaseURL:    databaseURL,
	}, nil
}

// LoadFromEnv 从进程环境读取。
func LoadFromEnv() (*Config, error) { return Load(os.Getenv) }

func getenvDefault(getenv Getenv, key, fallback string) string {
	if v := strings.TrimSpace(getenv(key)); v != "" {
		return v
	}
	return fallback
}

func splitAndTrim(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if trimmed := strings.TrimSpace(p); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func hasHTTPSOrigin(origins []string) bool {
	for _, o := range origins {
		if strings.HasPrefix(o, "https://") {
			return true
		}
	}
	return false
}
