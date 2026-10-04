// Command twofa-server 是 SecondTally 的同步服务。
//
// 它只做一件事:把密文安全地搬运给该看它的人。
// 它无法解密任何内容,也不需要知道主密码是什么。
//
// 用法:
//
//	twofa-server
//
// 所有配置来自环境变量,见 .env.example。
// 缺失或不合法的配置会直接退出而不是降级运行。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"twofa/server/internal/auth"
	"twofa/server/internal/config"
	"twofa/server/internal/httpapi"
	"twofa/server/internal/store"
)

func main() {
	log := newLogger()

	if err := run(log); err != nil {
		log.Error("服务退出", "error", err)
		os.Exit(1)
	}
}

func newLogger() *slog.Logger {
	level := slog.LevelInfo
	if os.Getenv("TWOFA_LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}
	// JSON 输出:便于 journald / Loki / ELK 直接采集。
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
}

func run(log *slog.Logger) error {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return err
	}

	if !cfg.IsProduction {
		log.Warn("TWOFA_TOKEN_SECRET 未设置,正在使用开发默认值。仅限本地开发。")
	}

	authSvc, err := auth.New(filepath.Join(cfg.DataDir, "credentials.json"), cfg.TokenSecret)
	if err != nil {
		return err
	}

	repo, err := store.Open(store.Options{
		Dialect:     store.Dialect(cfg.DBDriver),
		SQLitePath:  filepath.Join(cfg.DataDir, "vaults.db"),
		PostgresDSN: cfg.DatabaseURL,
	})
	if err != nil {
		return err
	}
	defer func() { _ = repo.Close() }()

	api := httpapi.New(cfg, authSvc, repo, log)
	server := &http.Server{
		Addr:    net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port)),
		Handler: api.Handler(),
		// 超时必须设置:没有超时的 HTTP 服务器是慢速攻击的入口。
		// 一个只发请求头不发正文的连接就能占住一个 goroutine 不放。
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 16, // 64KB,足够正常请求
	}

	log.Info("twofa 同步服务已启动",
		"addr", server.Addr,
		"env", envName(cfg.IsProduction),
		"dataDir", cfg.DataDir,
		"dbDriver", cfg.DBDriver,
		"corsOrigins", cfg.AllowedOrigins,
		"accessTokenTTL", cfg.AccessTokenTTL.String(),
	)

	// 监听在独立协程,把错误通过 channel 送回主协程。
	serveErr := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	// 等待停机信号或服务错误。
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-serveErr:
		if err != nil {
			return err
		}
		return nil

	case sig := <-signals:
		log.Info("收到信号,开始优雅停机", "signal", sig.String())

		// 先停止接收新连接,给在途请求 10 秒完成。
		// 粗暴 os.Exit(1) 会在同步写入中途断开连接,
		// 可能让用户误以为同步失败而重复操作。
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		if err := server.Shutdown(ctx); err != nil {
			log.Error("优雅停机超时,强制关闭", "error", err)
			return err
		}
		<-serveErr
		log.Info("服务已停止")
		return nil
	}
}

func envName(isProduction bool) string {
	if isProduction {
		return "production"
	}
	return "development"
}
