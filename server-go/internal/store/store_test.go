// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func newTestRepo(t *testing.T) *Repository {
	t.Helper()
	repo, err := Open(Options{
		Dialect:    DialectSQLite,
		SQLitePath: filepath.Join(t.TempDir(), "vaults.db"),
	})
	if err != nil {
		t.Fatalf("打开数据库失败: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func rev(n int64) *int64 { return &n }

func TestOpenCreatesSchema(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()

	if err := repo.Ping(ctx); err != nil {
		t.Fatalf("Ping 应成功: %v", err)
	}
	// 记录不存在时应返回 ErrNotFound 而不是别的错误,
	// 上层靠 errors.Is 判断来区分"首次上传"与真正的故障。
	_, err := repo.Get(ctx, "nobody")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的记录应返回 ErrNotFound, 得到 %v", err)
	}
}

// TestPutFirstWriteRequiresNoBaseRevision 锁定首次上传的语义:
// 客户端还不知道版本(baseRevision 为 nil)时才允许写入。
func TestPutFirstWriteRequiresNoBaseRevision(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	got, err := repo.Put(ctx, "alice", `{"v":1}`, now, "web-1", nil)
	if err != nil {
		t.Fatalf("首次上传应成功: %v", err)
	}
	if got != 1 {
		t.Fatalf("首次上传后 revision 应为 1, 得到 %d", got)
	}

	// 已存在记录时再传 nil(意味着"我以为你什么都没有"),
	// 必须被当作冲突拒绝——否则会静默覆盖。
	if _, err := repo.Put(ctx, "alice", `{"v":2}`, now+1, "web-1", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("记录已存在时传 nil 应返回 ErrConflict, 得到 %v", err)
	}

	// 数据必须完好。
	rec, err := repo.Get(ctx, "alice")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if rec.Envelope != `{"v":1}` {
		t.Fatalf("被拒绝的写入不应改动数据, 得到 %q", rec.Envelope)
	}
}

// TestPutFirstWriteAcceptsZeroBaseRevision 锁住一条真实的客户端契约。
//
// core 在首次同步时发出的是 `baseRevision: this.revision`,
// 而该字段初值为 0(见 packages/core/src/vault/service.ts:554)。
// 所以 0 与 nil 一样表示"客户端不知道服务端版本",都必须被接受——
// 否则新用户永远传不上第一份保险库。
//
// 这条测试是端到端实测发现的:原实现只认 nil,首发被判 409。
func TestPutFirstWriteAcceptsZeroBaseRevision(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	// 客户端首发:传 0,不是 nil。
	got, err := repo.Put(ctx, "alice", `{"v":1}`, now, "web-1", rev(0))
	if err != nil {
		t.Fatalf("客户端首发传 baseRevision=0 应成功(它表示不知道版本), 得到 %v", err)
	}
	if got != 1 {
		t.Fatalf("首发后 revision 应为 1, 得到 %d", got)
	}

	// 同样地,nil 也应被接受——两条路径都得通。
	if _, err := repo.Put(ctx, "bob", `{"v":1}`, now, "web-1", nil); err != nil {
		t.Fatalf("传 nil 也应表示不知道版本, 得到 %v", err)
	}

	// 关键:记录已存在时,客户端说"我不知道版本"(0 或 nil)
	// 必须被当作冲突拒绝,否则会静默覆盖另一台设备的数据。
	if _, err := repo.Put(ctx, "alice", `{"v":2}`, now+1, "web-1", rev(0)); !errors.Is(err, ErrConflict) {
		t.Fatalf("记录已存在时传 0 应返回 ErrConflict, 得到 %v", err)
	}
	if _, err := repo.Put(ctx, "alice", `{"v":2}`, now+1, "web-1", nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("记录已存在时传 nil 应返回 ErrConflict, 得到 %v", err)
	}

	// 数据必须完好。
	rec, err := repo.Get(ctx, "alice")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if rec.Envelope != `{"v":1}` {
		t.Fatalf("被拒绝的写入不应改动数据, 得到 %q", rec.Envelope)
	}
}

func TestPutIncrementsRevision(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	if _, err := repo.Put(ctx, "bob", `{"v":1}`, now, "web-1", nil); err != nil {
		t.Fatalf("首次上传失败: %v", err)
	}
	got, err := repo.Put(ctx, "bob", `{"v":2}`, now+1000, "web-2", rev(1))
	if err != nil {
		t.Fatalf("条件更新应成功: %v", err)
	}
	if got != 2 {
		t.Fatalf("revision 应递增到 2, 得到 %d", got)
	}

	rec, err := repo.Get(ctx, "bob")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if rec.Envelope != `{"v":2}` {
		t.Errorf("内容应被更新, 得到 %q", rec.Envelope)
	}
	if rec.DeviceID != "web-2" {
		t.Errorf("deviceId 应更新为最后一次写入方, 得到 %q", rec.DeviceID)
	}
	if rec.UpdatedAt != now+1000 {
		t.Errorf("updatedAt 应为客户端传入的值 %d, 得到 %d", now+1000, rec.UpdatedAt)
	}
}

func TestPutRejectsStaleRevision(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	if _, err := repo.Put(ctx, "carol", `{"v":1}`, now, "web-1", nil); err != nil {
		t.Fatalf("首次上传失败: %v", err)
	}
	if _, err := repo.Put(ctx, "carol", `{"v":2}`, now+1, "web-1", rev(1)); err != nil {
		t.Fatalf("第二次上传失败: %v", err)
	}

	// 拿着过期的 version=1 写入,必须被拒。
	if _, err := repo.Put(ctx, "carol", `{"v":3}`, now+2, "web-3", rev(1)); !errors.Is(err, ErrConflict) {
		t.Fatalf("过期版本号应返回 ErrConflict, 得到 %v", err)
	}
	rec, _ := repo.Get(ctx, "carol")
	if rec.Envelope != `{"v":2}` {
		t.Fatalf("冲突时数据必须完好, 得到 %q", rec.Envelope)
	}
}

// TestPutConcurrentWritersOnlyOneWins 是本包最关键的测试。
//
// TypeScript 版是"先 get 再条件 update"两步操作,并发下两个请求
// 都读到 revision=1、都通过检查,后写的覆盖先写的——静默丢数据。
// Go 版用单条 UPDATE 让数据库裁决,这里验证确实只有一个赢家。
func TestPutConcurrentWritersOnlyOneWins(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	if _, err := repo.Put(ctx, "dave", `{"v":0}`, now, "seed", nil); err != nil {
		t.Fatalf("种子数据写入失败: %v", err)
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
			<-start // 让所有协程同时冲,最大化竞态窗口
			_, err := repo.Put(ctx, "dave", fmt.Sprintf(`{"v":%d}`, n+1), now+int64(n), "web", rev(1))
			mu.Lock()
			defer mu.Unlock()
			switch {
			case err == nil:
				winners++
			case errors.Is(err, ErrConflict):
				losers++
			default:
				t.Errorf("非预期的错误: %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if winners != 1 {
		t.Errorf("并发写入应有且仅有 1 个赢家, 实际 %d 个(成功 %d / 冲突 %d)", winners, winners, losers)
	}
	if losers != writers-1 {
		t.Errorf("其余 %d 个应全部冲突, 实际冲突 %d", writers-1, losers)
	}

	// 最终 revision 必须是 2,且内容与胜者一致——
	// 证明没有出现"两个都成功写了不同内容"的覆盖。
	rec, err := repo.Get(ctx, "dave")
	if err != nil {
		t.Fatalf("读取失败: %v", err)
	}
	if rec.Revision != 2 {
		t.Errorf("最终 revision 应为 2, 得到 %d", rec.Revision)
	}
}

// TestPutConcurrentFirstWriters 验证记录不存在时的并发:
// 多个客户端同时首次上传,同样只能有一个成功。
func TestPutConcurrentFirstWriters(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	const writers = 8
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
	)
	start := make(chan struct{})

	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			_, err := repo.Put(ctx, "erin", fmt.Sprintf(`{"v":%d}`, n), now+int64(n), "web", nil)
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				winners++
				return
			}
			if !errors.Is(err, ErrConflict) {
				t.Errorf("非预期的错误: %v", err)
			}
		}(i)
	}
	close(start)
	wg.Wait()

	if winners != 1 {
		t.Errorf("并发首次上传应只有 1 个赢家, 实际 %d", winners)
	}
}

// TestRecentSyncsRecordsMetadataOnly 确认同步日志只有元数据。
// 一旦这里出现内容字段,就是明文泄漏点。
func TestRecentSyncsRecordsMetadataOnly(t *testing.T) {
	repo := newTestRepo(t)
	ctx := context.Background()
	now := int64(1700000000000)

	if _, err := repo.Put(ctx, "frank", `{"secret":"ciphertext"}`, now, "web-1", nil); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if _, err := repo.Put(ctx, "frank", `{"secret":"ciphertext2"}`, now+1000, "web-2", rev(1)); err != nil {
		t.Fatalf("第二次写入失败: %v", err)
	}

	entries, err := repo.RecentSyncs(ctx, "frank", 20)
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("应有 2 条同步记录, 得到 %d", len(entries))
	}
	// 按时间倒序:最近的在前。
	if entries[0].DeviceID != "web-2" {
		t.Errorf("最近一次应是 web-2, 得到 %q", entries[0].DeviceID)
	}
	if entries[0].Revision != 2 {
		t.Errorf("最近的 revision 应为 2, 得到 %d", entries[0].Revision)
	}
	if entries[0].Bytes == 0 {
		t.Error("应记录字节数")
	}

	// 限额必须生效,防止日志表被撑大。
	limited, err := repo.RecentSyncs(ctx, "frank", 1)
	if err != nil {
		t.Fatalf("限量查询失败: %v", err)
	}
	if len(limited) != 1 {
		t.Errorf("限量 1 应只返回 1 条, 得到 %d", len(limited))
	}

	// 其他用户看不到别人的日志。
	if entries, _ := repo.RecentSyncs(ctx, "someone-else", 20); len(entries) != 0 {
		t.Errorf("不应返回其他用户的记录, 得到 %d 条", len(entries))
	}
}

// TestPersistenceAcrossReopen 确认数据真的落盘,
// 而不只是留在内存里——重启后用户不该"丢保险库"。
func TestPersistenceAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vaults.db")
	ctx := context.Background()

	repo, err := Open(Options{Dialect: DialectSQLite, SQLitePath: path})
	if err != nil {
		t.Fatalf("首次打开失败: %v", err)
	}
	if _, err := repo.Put(ctx, "grace", `{"v":1}`, 1700000000000, "web-1", nil); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}

	reopened, err := Open(Options{Dialect: DialectSQLite, SQLitePath: path})
	if err != nil {
		t.Fatalf("重新打开失败: %v", err)
	}
	defer func() { _ = reopened.Close() }()

	rec, err := reopened.Get(ctx, "grace")
	if err != nil {
		t.Fatalf("重启后应能读到记录: %v", err)
	}
	if rec.Envelope != `{"v":1}` || rec.Revision != 1 {
		t.Errorf("重启后数据不一致: %+v", rec)
	}
}
