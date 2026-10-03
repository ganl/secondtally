// Aegis 2FA 同步服务。
//
// 选 Go 而非 Node 的原因:部署只需一个静态二进制,无运行时依赖,
// 交叉编译到 ARM 机器(Gentoo 本身就是)直接跑;
// 单二进制 + 内置并发模型,同步服务这种IO 密集型负载下延迟与吞吐都更稳。
//
// 目录划分沿用 TypeScript 版的结构,便于逐点对照:
//   internal/auth    服务端身份认证(scrypt 口令 + HMAC 令牌)
//   internal/store   密文存储(SQLite)
//   internal/httpapi 路由、CORS、限流
//   internal/config  启动配置与校验
module aegis/server

go 1.26.0

require (
	golang.org/x/crypto v0.57.0
	golang.org/x/text v0.42.0
	modernc.org/sqlite v1.60.1
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/mattn/go-isatty v0.0.24 // indirect
	github.com/ncruces/go-strftime v1.0.0 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.48.0 // indirect
	modernc.org/libc v1.77.1 // indirect
	modernc.org/mathutil v1.7.1 // indirect
	modernc.org/memory v1.12.1 // indirect
)
