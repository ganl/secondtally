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
}

// 默认值。与 .env.example 保持一致。
const (
	defaultPort    = 8787
	defaultHost    = "127.0.0.1"
	defaultDataDir = "./server/data"
	defaultTTLSecs = 3600

	// devSecret 仅用于本地开发,生产环境会拒绝使用它。
	devSecret = "dev-only-insecure-secret-do-not-use-in-production"

	minSecretLength = 32
)

// Getenv 抽象出便于测试的环境变量读取。
type Getenv func(string) string

// Load 读取并校验配置。
//
// 返回错误时调用方必须直接退出——不要降级到"部分可用"的状态,
// 那意味着用户以为自己在安全配置下运行。
func Load(getenv Getenv) (*Config, error) {
	isProduction := getenv("NODE_ENV") == "production"

	tokenSecret := strings.TrimSpace(getenv("AEGIS_TOKEN_SECRET"))
	if tokenSecret == "" {
		if isProduction {
			return nil, fmt.Errorf(
				"生产环境必须设置 AEGIS_TOKEN_SECRET,生成方式: openssl rand -hex 32")
		}
		// 开发环境回退到固定值,但它必须在下面被生产校验拒绝。
		tokenSecret = devSecret
	}

	if isProduction {
		if tokenSecret == devSecret {
			return nil, fmt.Errorf("生产环境拒绝使用开发默认密钥")
		}
		if len(tokenSecret) < minSecretLength {
			return nil, fmt.Errorf("生产环境的 AEGIS_TOKEN_SECRET 至少需要 %d 个字符", minSecretLength)
		}
	}

	origins := splitAndTrim(getenv("AEGIS_ALLOWED_ORIGINS"))
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

	ttlSecs, err := strconv.Atoi(getenvDefault(getenv, "AEGIS_TOKEN_TTL", strconv.Itoa(defaultTTLSecs)))
	if err != nil || ttlSecs < 60 || ttlSecs > 30*24*3600 {
		return nil, fmt.Errorf("AEGIS_TOKEN_TTL 必须是 60 到 %d 秒之间的数字", 30*24*3600)
	}

	dataDir := getenvDefault(getenv, "AEGIS_DATA_DIR", defaultDataDir)
	absData, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, fmt.Errorf("AEGIS_DATA_DIR 不是合法路径: %w", err)
	}

	return &Config{
		Port:           port,
		Host:           getenvDefault(getenv, "HOST", defaultHost),
		DataDir:        absData,
		TokenSecret:    tokenSecret,
		AllowedOrigins: origins,
		AccessTokenTTL: time.Duration(ttlSecs) * time.Second,
		IsProduction:   isProduction,
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
