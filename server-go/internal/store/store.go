// Package store 是密文存储层。
//
// 最重要的设计约束:这个表里只允许出现密文。
// 任何试图写入明文字段的代码路径都不应该存在——
// 服务端被脱库时,攻击者拿到的必须是一堆无法解读的字符串。
//
// 选用 SQLite 的理由:单文件、零运维、易备份。
// 若后期要多实例横向扩展,把 Repository 换成 Postgres 即可,
// 上层httpapi 无需改动(接口保持一致)。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	// SQLite 驱动。这里用纯 Go 的 modernc.org/sqlite:
	// 需要 CGO 的 mattn/go-sqlite3 在交叉编译到无C 工具链的机器
	// (Gentoo、scratch 容器镜像)时会失败,而这个服务本可以轻松单文件部署。
	_ "modernc.org/sqlite"
)

var (
	// ErrNotFound 表示记录不存在。
	ErrNotFound = errors.New("记录不存在")
	// ErrConflict 表示乐观并发检查失败,调用方应转为 409 交由客户端合并,
	// 绝不静默覆盖。
	ErrConflict = errors.New("版本冲突")
)

// Vault 是一条保险库记录。
//
// Envelope 是客户端上传的密文。本服务不解析、不解读、不校验其内容——
// 它连主密码是什么都不知道。
type Vault struct {
	UserID    string
	Envelope  string
	Revision  int64
	UpdatedAt int64
	DeviceID  string
}

// SyncEntry 是一次同步的元数据。
//
// 注意这里没有任何"内容"字段。服务端只记"谁在什么时候传了多少字节",
// 记录内容会成为明文泄漏点,那正是这套系统要消除的东西。
type SyncEntry struct {
	DeviceID string `json:"deviceId"`
	Revision int64  `json:"revision"`
	Bytes    int64  `json:"bytes"`
	At       int64  `json:"at"`
}

// Repository 是 SQLite 存储。
type Repository struct {
	db *sql.DB
}

// Open 打开(或创建)数据库并建表。
func Open(file string) (*Repository, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}

	// WAL 模式:读写不互相阻塞。同步场景下这是必需的——
	// 一个设备在拉取时不应阻塞另一个在上传。
	// busy_timeout 让并发写冲突时自动重试而不是立刻报 SQLITE_BUSY。
	dsn := file + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}

	// SQLite 写并发有限,限制连接数反而更快也更稳。
	// 配合 WAL,读写可以真正并行。
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(time.Hour)

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("数据库不可用: %w", err)
	}

	repo := &Repository{db: db}
	if err := repo.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return repo, nil
}

func (r *Repository) migrate() error {
	schema := `
    CREATE TABLE IF NOT EXISTS vaults (
      user_id     TEXT PRIMARY KEY,
      envelope    TEXT NOT NULL,
      revision    INTEGER NOT NULL DEFAULT 1,
      updated_at  INTEGER NOT NULL,
      device_id   TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      revision    INTEGER NOT NULL,
      bytes       INTEGER NOT NULL,
      at          INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id, at DESC);
    `
	if _, err := r.db.Exec(schema); err != nil {
		return fmt.Errorf("初始化表结构失败: %w", err)
	}
	return nil
}

// Close 关闭数据库。
func (r *Repository) Close() error { return r.db.Close() }

// Ping 用于 /ready 探针:能查到库说明 SQLite 可用。
func (r *Repository) Ping(ctx context.Context) error {
	var one int
	return r.db.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
}

// Get 读取记录。不存在返回 ErrNotFound。
func (r *Repository) Get(ctx context.Context, userID string) (*Vault, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT user_id, envelope, revision, updated_at, device_id FROM vaults WHERE user_id = ?`, userID)

	var v Vault
	err := row.Scan(&v.UserID, &v.Envelope, &v.Revision, &v.UpdatedAt, &v.DeviceID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("读取保险库失败: %w", err)
	}
	return &v, nil
}

// Put 条件写入。
//
// baseRevision 为 nil 表示"必须不存在才写入"(首次上传)。
// 版本不匹配时返回 ErrConflict,绝不覆盖。
//
// 实现上用单条 UPDATE 让判断与写入在同一个事务里原子完成。
// TypeScript 版是"先 get 再按 revision 条件 update"两步操作,
// 并发下存在 TOCTOU 窗口:两个请求都读到 revision=1,都通过检查,
// 后写的覆盖先写的。这里让数据库自己判定,从根本上消除该竞态。
func (r *Repository) Put(
	ctx context.Context,
	userID, envelope string,
	updatedAt int64,
	deviceID string,
	baseRevision *int64,
) (int64, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("开启事务失败: %w", err)
	}
	// 回滚时忽略错误:tx 已提交或已回滚时都会返回 ErrTxDone,
	// 那不是需要处理的问题。
	defer func() { _ = tx.Rollback() }()

	var current int64
	err = tx.QueryRowContext(ctx,
		`SELECT revision FROM vaults WHERE user_id = ?`, userID).Scan(&current)

	switch {
	case errors.Is(err, sql.ErrNoRows):
		// 记录不存在:仅当客户端也不知道版本(首次上传)时才允许写入。
		if baseRevision != nil {
			return 0, ErrConflict
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO vaults (user_id, envelope, revision, updated_at, device_id, created_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
			userID, envelope, updatedAt, deviceID, time.Now().UnixMilli(),
		); err != nil {
			return 0, fmt.Errorf("写入保险库失败: %w", err)
		}
		if err := logSync(ctx, tx, userID, deviceID, 1, int64(len(envelope)), updatedAt); err != nil {
			return 0, err
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("提交事务失败: %w", err)
		}
		return 1, nil

	case err != nil:
		return 0, fmt.Errorf("查询当前版本失败: %w", err)

	default:
		if baseRevision == nil || *baseRevision != current {
			return 0, ErrConflict
		}
		next := current + 1
		// WHERE 里带上 revision,让数据库做最终裁决。
		// 即便前面的检查因并发而失效,这里也不会误覆盖。
		res, err := tx.ExecContext(ctx,
			`UPDATE vaults SET envelope = ?, updated_at = ?, device_id = ?, revision = ?
       WHERE user_id = ? AND revision = ?`,
			envelope, updatedAt, deviceID, next, userID, current,
		)
		if err != nil {
			return 0, fmt.Errorf("更新保险库失败: %w", err)
		}
		affected, err := res.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("读取更新结果失败: %w", err)
		}
		if affected == 0 {
			// 查询与更新之间被其他请求插队了。
			return 0, ErrConflict
		}
		if err := logSync(ctx, tx, userID, deviceID, next, int64(len(envelope)), updatedAt); err != nil {
			return 0, err
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("提交事务失败: %w", err)
		}
		return next, nil
	}
}

func logSync(ctx context.Context, tx *sql.Tx, userID, deviceID string, revision, bytes, at int64) error {
	_, err := tx.ExecContext(ctx,
		`INSERT INTO sync_log (user_id, device_id, revision, bytes, at) VALUES (?, ?, ?, ?, ?)`,
		userID, deviceID, revision, bytes, at)
	if err != nil {
		return fmt.Errorf("写入同步日志失败: %w", err)
	}
	return nil
}

// RecentSyncs 返回最近的同步元数据,不含任何内容。
func (r *Repository) RecentSyncs(ctx context.Context, userID string, limit int) ([]SyncEntry, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := r.db.QueryContext(ctx,
		`SELECT device_id, revision, bytes, at FROM sync_log
     WHERE user_id = ? ORDER BY at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("查询同步日志失败: %w", err)
	}
	defer rows.Close()

	entries := make([]SyncEntry, 0, limit)
	for rows.Next() {
		var e SyncEntry
		if err := rows.Scan(&e.DeviceID, &e.Revision, &e.Bytes, &e.At); err != nil {
			return nil, fmt.Errorf("解析同步日志失败: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}
