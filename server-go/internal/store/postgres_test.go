package store

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
)

// postgresDSN 返回用于集成测试的连接串,未设置则跳过。
//
// 为什么默认跳过:CI 与多数开发机都没有装 PostgreSQL。
// 让测试强制要求外部服务会导致"克隆下来跑不起来"。
// 需要验证 PG 行为时用下面一行启动本地实例:
//
//	docker run -d --name aegis-pg -e POSTGRES_PASSWORD=postgres \
//	  -e POSTGRES_DB=aegis_test -p 5433:5432 postgres:16
//	AEGIS_TEST_POSTGRES="postgres://postgres:postgres@127.0.0.1:5433/aegis_test?sslmode=disable" go test ./...
func postgresDSN() string { return os.Getenv("AEGIS_TEST_POSTGRES") }

// newPostgresRepo 打开一个连到测试库的 Repository,并清空两张表。
func newPostgresRepo(t *testing.T) *Repository {
	t.Helper()
	dsn := postgresDSN()
	if dsn == "" {
		t.Skip("未设置 AEGIS_TEST_POSTGRES,跳过 PostgreSQL 集成测试")
	}
	repo, err := Open(Options{Dialect: DialectPostgres, PostgresDSN: dsn})
	if err != nil {
		t.Fatalf("连接 PostgreSQL 失败: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })

	// 每次测试前清空,避免互相干扰。
	if _, err := repo.db.Exec(`TRUNCATE vaults, sync_log`); err != nil {
		t.Fatalf("清空测试表失败: %v", err)
	}
	return repo
}

// TestPostgresRoundTrip 验证 PG 上的完整读写路径。
//
// 重点是密文原样往返与 revision 递增——
// 占位符改写如果出错,这里会直接报 "there is no parameter $N"。
func TestPostgresRoundTrip(t *testing.T) {
	repo := newPostgresRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	// 首发:baseRevision=0 必须成功(与 SQLite 同一契约)。
	got, err := repo.Put(ctx, "pg-user", `{"v":1}`, now, "dev-1", rev(0))
	if err != nil {
		t.Fatalf("PG 首发应成功: %v", err)
	}
	if got != 1 {
		t.Fatalf("首发后 revision 应为 1, 得到 %d", got)
	}

	// 密文必须原样读回。
	rec, err := repo.Get(ctx, "pg-user")
	if err != nil {
		t.Fatalf("PG 读取失败: %v", err)
	}
	if rec.Envelope != `{"v":1}` || rec.Revision != 1 || rec.DeviceID != "dev-1" {
		t.Fatalf("PG 读取内容不一致: %+v", rec)
	}

	// 正确 baseRevision 递增到 2。
	got, err = repo.Put(ctx, "pg-user", `{"v":2}`, now+1, "dev-1", rev(1))
	if err != nil {
		t.Fatalf("PG 二次写入应成功: %v", err)
	}
	if got != 2 {
		t.Fatalf("二次写入后 revision 应为 2, 得到 %d", got)
	}

	// 过期 baseRevision 必须冲突。
	if _, err := repo.Put(ctx, "pg-user", `{"v":3}`, now+2, "dev-1", rev(1)); !errors.Is(err, ErrConflict) {
		t.Fatalf("过期版本应返回 ErrConflict, 得到 %v", err)
	}

	// 数据必须完好。
	rec, _ = repo.Get(ctx, "pg-user")
	if rec.Envelope != `{"v":2}` || rec.Revision != 2 {
		t.Fatalf("被拒绝的写入不应改动数据: %+v", rec)
	}
}

// TestPostgresGetNotFound 确认不存在时返回 ErrNotFound 而非 PG 原始错误。
func TestPostgresGetNotFound(t *testing.T) {
	repo := newPostgresRepo(t)
	if _, err := repo.Get(context.Background(), "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("应返回 ErrNotFound, 得到 %v", err)
	}
}

// TestPostgresConcurrentWritersOnlyOneWins 验证 PG 行级锁带来的并发语义。
//
// 这是选 PG 的主要理由:SQLite 整库串行写,高并发下会 SQLITE_BUSY。
// 这里让 8 个协程同时写同一用户,应恰好一个成功。
func TestPostgresConcurrentWritersOnlyOneWins(t *testing.T) {
	repo := newPostgresRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	// 先建一条记录,让所有写入者都走"更新"路径(竞争最激烈的那条)。
	if _, err := repo.Put(ctx, "pg-race", `{"v":0}`, now, "dev-0", nil); err != nil {
		t.Fatalf("预置记录失败: %v", err)
	}

	const writers = 8
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
		losers  int
	)
	start := make(chan struct{})
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			// 都基于 revision 1 写入,只有一个人能成功。
			_, err := repo.Put(ctx, "pg-race", `{"v":1}`, now+int64(n+1), "dev-0", rev(1))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				winners++
			case errors.Is(err, ErrConflict):
				losers++
			default:
				t.Errorf("非预期错误: %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if winners != 1 {
		t.Errorf("并发写入应恰好 1 个赢家, 实际 %d 个(其余 %d 个)", winners, losers)
	}
}

// TestPostgresRecentSyncs 验证同步日志查询在 PG 上正常。
func TestPostgresRecentSyncs(t *testing.T) {
	repo := newPostgresRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	if _, err := repo.Put(ctx, "pg-log", `{"v":1}`, now, "dev-a", nil); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if _, err := repo.Put(ctx, "pg-log", `{"v":2}`, now+1000, "dev-a", rev(1)); err != nil {
		t.Fatalf("二次写入失败: %v", err)
	}

	entries, err := repo.RecentSyncs(ctx, "pg-log", 10)
	if err != nil {
		t.Fatalf("查询同步日志失败: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("应有 2 条同步记录, 得到 %d", len(entries))
	}
	// 按时间倒序。
	if entries[0].Revision != 2 || entries[1].Revision != 1 {
		t.Errorf("同步日志应按时间倒序, 得到 %+v", entries)
	}
	// 确认没有内容字段——那会变成明文泄漏点。
	if entries[0].DeviceID != "dev-a" {
		t.Errorf("同步日志 deviceId 不对: %+v", entries[0])
	}
}

// TestPostgresConcurrentFirstWriters 确认并发首发时唯一键冲突被转成冲突。
//
// 这条专门覆盖 isUniqueViolation:两个请求同时 INSERT,
// 第二个会遇到唯一键冲突,必须变成 ErrConflict 让客户端合并。
func TestPostgresConcurrentFirstWriters(t *testing.T) {
	repo := newPostgresRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	const writers = 5
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
		losers  int
	)
	start := make(chan struct{})
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			// 全部使用"不知道版本",都试图创建。
			_, err := repo.Put(ctx, "pg-first", `{"v":1}`, now+int64(n), "dev-0", rev(0))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				winners++
			case errors.Is(err, ErrConflict):
				losers++
			default:
				t.Errorf("唯一键冲突应被转为 ErrConflict, 得到 %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if winners != 1 {
		t.Errorf("并发首发应恰好 1 个赢家, 实际 %d 个(其余 %d 个)", winners, losers)
	}

	// 记录应存在且只一条。
	rec, err := repo.Get(ctx, "pg-first")
	if err != nil {
		t.Fatalf("首发后应能读到记录: %v", err)
	}
	if rec.Revision != 1 {
		t.Errorf("revision 应为 1, 得到 %d", rec.Revision)
	}
}

// TestPostgresPing 确认 /ready 探针在 PG 上可用。
func TestPostgresPing(t *testing.T) {
	repo := newPostgresRepo(t)
	if err := repo.Ping(context.Background()); err != nil {
		t.Fatalf("Ping 应成功: %v", err)
	}
	if repo.Dialect() != DialectPostgres {
		t.Errorf("Dialect() 应返回 postgres, 得到 %s", repo.Dialect())
	}
}
