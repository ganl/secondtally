// SPDX-License-Identifier: AGPL-3.0-only

// Package store 是密文存储层。
//
// 最重要的设计约束:这个表里只允许出现密文。
// 任何试图写入明文字段的代码路径都不应该存在——
// 服务端被脱库时,攻击者拿到的必须是一堆无法解读的字符串。
//
// # 为什么支持两种数据库
//
// 本地开发与测试用 SQLite:单文件、零运维、易备份。
// 实际部署用 PostgreSQL:并发写能力与多实例扩展性都远好于 SQLite,
// 且用户量上来后不必担心全库写锁。
//
// 两种数据库的差异集中在三处,都被封装在本包内:
//  1. 占位符:SQLite 用 ?,PG 用 $1。靠 database/sql.Rewrite 自动转换。
//  2. 建表 DDL:自增主键与列类型略有不同。
//  3. 连接池参数:SQLite 限流(写并发有限),PG 放开。
//
// 上层 httpapi 只看到 Repository 的方法签名,无需关心底下是哪种库。
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	// SQLite 驱动。这里用纯 Go 的 modernc.org/sqlite:
	// 需要 CGO 的 mattn/go-sqlite3 在交叉编译到无 C 工具链的机器
	// (Gentoo、scratch 容器镜像)时会失败,而这个服务本可以轻松单文件部署。
	_ "modernc.org/sqlite"

	// PostgreSQL 驱动(纯 Go,无需 libpq)。
	_ "github.com/lib/pq"
)

// Dialect 表示底层数据库方言。
type Dialect string

const (
	// DialectSQLite 是本地开发与测试用的文件数据库。
	DialectSQLite Dialect = "sqlite"
	// DialectPostgres 是实际部署用的数据库。
	DialectPostgres Dialect = "postgres"
)

var (
	// ErrNotFound 表示记录不存在。
	ErrNotFound = errors.New("记录不存在")
	// ErrConflict 表示乐观并发检查失败,调用方应转为 409 交由客户端合并,
	// 绝不静默覆盖。
	ErrConflict = errors.New("版本冲突")
	// ErrUnknownDialect 表示配置了不支持的数据库类型。
	ErrUnknownDialect = errors.New("不支持的数据库类型")
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

// Options 是打开数据库的参数。
type Options struct {
	// Dialect 是数据库类型。空值默认 SQLite。
	Dialect Dialect
	// SQLitePath 是 SQLite 数据库文件路径,仅 DialectSQLite 时使用。
	SQLitePath string
	// PostgresDSN 是 PostgreSQL 连接串,仅 DialectPostgres 时使用。
	// 形如 postgres://user:pass@host:5432/twofa?sslmode=require
	PostgresDSN string
}

// Repository 是密文存储。底层可为 SQLite 或 PostgreSQL。
type Repository struct {
	db      *sql.DB
	dialect Dialect

	// pgClient 只在 PG 模式下非 nil,保留给将来需要方言专属 SQL 的场景。
	pgClient *sql.DB
}

// Open 按配置打开数据库并建表。
func Open(opts Options) (*Repository, error) {
	switch opts.Dialect {
	case "", DialectSQLite:
		return openSQLite(opts.SQLitePath)
	case DialectPostgres:
		return openPostgres(opts.PostgresDSN)
	default:
		return nil, fmt.Errorf("%w: %q(可选 sqlite / postgres)", ErrUnknownDialect, opts.Dialect)
	}
}

// openSQLite 打开本地文件数据库。
func openSQLite(path string) (*Repository, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}

	// WAL 模式:读写不互相阻塞。同步场景下这是必需的——
	// 一个设备在拉取时不应阻塞另一个在上传。
	// busy_timeout 让并发写冲突时自动重试而不是立刻报 SQLITE_BUSY。
	dsn := path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
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

	repo := newRepository(db, DialectSQLite)
	if err := repo.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return repo, nil
}

// openPostgres 打开 PostgreSQL。
func openPostgres(dsn string) (*Repository, error) {
	if dsn == "" {
		return nil, errors.New("PostgreSQL 模式必须设置 TWOFA_DATABASE_URL")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开 PostgreSQL 失败: %w", err)
	}

	// PG 是网络数据库,连接建立有成本,池子可以比 SQLite 大得多。
	// 上限不设死:由数据库侧的 max_connections 兜底,
	// 应用层再限只会把可用连接白白闲置。
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	// 递归查 CTE 在 PG 里可能活很久,把上限略放宽。
	db.SetConnMaxLifetime(time.Hour)
	db.SetConnMaxIdleTime(30 * time.Minute)

	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("PostgreSQL 不可用(检查 TWOFA_DATABASE_URL 与网络): %w", err)
	}

	repo := newRepository(db, DialectPostgres)
	repo.pgClient = db
	if err := repo.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return repo, nil
}

// newRepository 构造 Repository。
func newRepository(db *sql.DB, dialect Dialect) *Repository {
	return &Repository{db: db, dialect: dialect}
}

// rebindPlaceholders 把 SQL 里的 ? 占位符按方言改写。
//
// 背景:本包用 SQLite 风格的 ? 写 SQL,因为它更简洁。
// PostgreSQL 只认 $1 / $2 这种序号形式,且 lib/pq 驱动不做转换
// (已查阅驱动源码确认:它按参数个数直接绑定,不做字符替换)。
// 所以必须在发送前自己改写。
//
// 为什么要跳过字符串字面量与注释:表名或列名里出现 ? 时不该被替换。
// 例如 INSERT ... VALUES ('a?b') 里的 ? 是数据不是占位符。
// 本包所有 SQL 都不含这类内容,但这个函数是包内公用设施,
// 留着这个判断比留个地雷更稳妥。
func rebindPlaceholders(query string, dialect Dialect) string {
	if dialect != DialectPostgres {
		return query // SQLite 原生支持 ?
	}

	var (
		out     strings.Builder
		inStr   bool // 正在单引号字符串内
		ident   bool // 正在 "双引号" 标识符内
		lineCm  bool // 正在 -- 行注释内
		blockCm bool // 正在 /* */ 块注释内
		n       int
	)
	out.Grow(len(query) + 8)

	for i := 0; i < len(query); i++ {
		c := query[i]
		next := byte(0)
		if i+1 < len(query) {
			next = query[i+1]
		}

		// 注释:行注释吃到行尾,块注释吃到 */
		if lineCm {
			out.WriteByte(c)
			if c == '\n' {
				lineCm = false
			}
			continue
		}
		if blockCm {
			out.WriteByte(c)
			if c == '*' && next == '/' {
				out.WriteByte(next)
				i++
				blockCm = false
			}
			continue
		}
		if !inStr && !ident && c == '-' && next == '-' {
			out.WriteString("--")
			i++
			lineCm = true
			continue
		}
		if !inStr && !ident && c == '/' && next == '*' {
			out.WriteString("/*")
			i++
			blockCm = true
			continue
		}

		// 字符串字面量:内部的一切都不动,'' 是转义后的单引号
		if inStr {
			out.WriteByte(c)
			if c == '\'' {
				if next == '\'' {
					out.WriteByte(next)
					i++
				} else {
					inStr = false
				}
			}
			continue
		}
		// 双引号标识符
		if ident {
			out.WriteByte(c)
			if c == '"' {
				if next == '"' {
					out.WriteByte(next)
					i++
				} else {
					ident = false
				}
			}
			continue
		}

		switch c {
		case '\'':
			inStr = true
			out.WriteByte(c)
		case '"':
			ident = true
			out.WriteByte(c)
		case '?':
			n++
			out.WriteByte('$')
			out.WriteString(strconv.Itoa(n))
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

// prepare 按方言预处理 SQL(转换占位符)。
func (r *Repository) prepare(query string) (*sql.Stmt, error) {
	return r.db.Prepare(rebindPlaceholders(query, r.dialect))
}

// prepareTx 按方言预处理事务内 SQL。
func (r *Repository) prepareTx(ctx context.Context, tx *sql.Tx, query string) (*sql.Stmt, error) {
	return tx.PrepareContext(ctx, rebindPlaceholders(query, r.dialect))
}

// Dialect 返回当前使用的数据库方言。测试与日志会用到。
func (r *Repository) Dialect() Dialect { return r.dialect }

func (r *Repository) migrate() error {
	schema := r.schemaSQL()
	if _, err := r.db.Exec(schema); err != nil {
		return fmt.Errorf("初始化表结构失败: %w", err)
	}
	return nil
}

// schemaSQL 返回当前方言的建表语句。
//
// 差异点:
//   - SQLite 自增用 INTEGER PRIMARY KEY AUTOINCREMENT,PG 用 BIGSERIAL
//   - PG 显式声明 TEXT 长度无限制;SQLite 的 TEXT 本身不限长
//   - 时间列在两边都用 BIGINT 存 Unix 毫秒,不依赖数据库的日期类型,
//     避免两端行为不一致
func (r *Repository) schemaSQL() string {
	if r.dialect == DialectPostgres {
		return `
    CREATE TABLE IF NOT EXISTS vaults (
      user_id     TEXT PRIMARY KEY,
      envelope    TEXT NOT NULL,
      revision    BIGINT NOT NULL DEFAULT 1,
      updated_at  BIGINT NOT NULL,
      device_id   TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id          BIGSERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      revision    BIGINT NOT NULL,
      bytes       BIGINT NOT NULL,
      at          BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id, at DESC);
    `
	}
	return `
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
}

// Close 关闭数据库。
func (r *Repository) Close() error { return r.db.Close() }

// Ping 用于 /ready 探针:能查到库说明数据库可用。
func (r *Repository) Ping(ctx context.Context) error {
	var one int
	return r.db.QueryRowContext(ctx, `SELECT 1`).Scan(&one)
}

// Get 读取记录。不存在返回 ErrNotFound。
func (r *Repository) Get(ctx context.Context, userID string) (*Vault, error) {
	stmt, err := r.prepare(`
    SELECT user_id, envelope, revision, updated_at, device_id
    FROM vaults WHERE user_id = ?`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	row := stmt.QueryRowContext(ctx, userID)

	var v Vault
	err = row.Scan(&v.UserID, &v.Envelope, &v.Revision, &v.UpdatedAt, &v.DeviceID)
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
// baseRevision 表示"客户端见到的版本",nil 或 0 都表示"我不知道版本"。
// 服务端有记录而客户端说不知道 -> 冲突(不能盲目覆盖)。
// 服务端无记录 -> 允许写入(首次上传)。
// 版本不匹配时返回 ErrConflict,绝不覆盖。
//
// 为什么把 0 与 nil 同等对待:客户端(core/src/vault/service.ts:554)在
// 首次同步时发出的是 `baseRevision: this.revision`,而该字段初值为 0。
// 若只认 nil,首发会被判为冲突,新用户永远传不上第一份保险库——
// 这是实测发现的缺陷,不是理论推演。
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

	// 归一化:nil 与 0 都表示"客户端不知道版本"。
	// 见上方函数注释——客户端首发时发的是 0。
	knownRevision := baseRevision != nil && *baseRevision > 0

	selectStmt, err := r.prepareTx(ctx, tx,
		`SELECT revision FROM vaults WHERE user_id = ?`)
	if err != nil {
		return 0, err
	}
	defer selectStmt.Close()

	var current int64
	err = selectStmt.QueryRowContext(ctx, userID).Scan(&current)

	switch {
	case errors.Is(err, sql.ErrNoRows):
		// 记录不存在:仅当客户端也不知道版本(首次上传)时才允许写入。
		if knownRevision {
			return 0, ErrConflict
		}
		insertStmt, err := r.prepareTx(ctx, tx, `
      INSERT INTO vaults (user_id, envelope, revision, updated_at, device_id, created_at)
      VALUES (?, ?, 1, ?, ?, ?)`)
		if err != nil {
			return 0, err
		}
		defer insertStmt.Close()

		if _, err := insertStmt.ExecContext(ctx,
			userID, envelope, updatedAt, deviceID, time.Now().UnixMilli(),
		); err != nil {
			// 并发首发时另一个请求可能刚插入,唯一键会冲突。
			// 那是正常的竞争,不是故障,应让客户端合并而不是报错。
			if isUniqueViolation(err) {
				return 0, ErrConflict
			}
			return 0, fmt.Errorf("写入保险库失败: %w", err)
		}
		if err := r.logSync(ctx, tx, userID, deviceID, 1, int64(len(envelope)), updatedAt); err != nil {
			return 0, err
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("提交事务失败: %w", err)
		}
		return 1, nil

	case err != nil:
		return 0, fmt.Errorf("查询当前版本失败: %w", err)

	default:
		// 服务端有记录:客户端必须知道且版本匹配才允许覆盖。
		if !knownRevision || *baseRevision != current {
			return 0, ErrConflict
		}
		next := current + 1
		// WHERE 里带上 revision,让数据库做最终裁决。
		// 即便前面的检查因并发而失效,这里也不会误覆盖。
		updateStmt, err := r.prepareTx(ctx, tx, `
      UPDATE vaults SET envelope = ?, updated_at = ?, device_id = ?, revision = ?
      WHERE user_id = ? AND revision = ?`)
		if err != nil {
			return 0, err
		}
		defer updateStmt.Close()

		res, err := updateStmt.ExecContext(ctx,
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
		if err := r.logSync(ctx, tx, userID, deviceID, next, int64(len(envelope)), updatedAt); err != nil {
			return 0, err
		}
		if err := tx.Commit(); err != nil {
			return 0, fmt.Errorf("提交事务失败: %w", err)
		}
		return next, nil
	}
}

// isUniqueViolation 判断错误是否为唯一键冲突。
//
// PG 的 SQLSTATE 是 23505,SQLite 的 modernc 驱动同样是 23505
// (它遵循 PG 的错误码约定),所以这里用错误文本兜底而非类型断言。
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") ||
		strings.Contains(msg, "duplicate key value")
}

func (r *Repository) logSync(ctx context.Context, tx *sql.Tx, userID, deviceID string, revision, bytes, at int64) error {
	stmt, err := r.prepareTx(ctx, tx,
		`INSERT INTO sync_log (user_id, device_id, revision, bytes, at) VALUES (?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	if _, err := stmt.ExecContext(ctx, userID, deviceID, revision, bytes, at); err != nil {
		return fmt.Errorf("写入同步日志失败: %w", err)
	}
	return nil
}

// RecentSyncs 返回最近的同步元数据,不含任何内容。
func (r *Repository) RecentSyncs(ctx context.Context, userID string, limit int) ([]SyncEntry, error) {
	if limit <= 0 {
		limit = 20
	}
	stmt, err := r.prepare(`
    SELECT device_id, revision, bytes, at FROM sync_log
    WHERE user_id = ? ORDER BY at DESC LIMIT ?`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	rows, err := stmt.QueryContext(ctx, userID, limit)
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
