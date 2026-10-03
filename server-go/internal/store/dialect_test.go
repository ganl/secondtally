package store

import (
	"strings"
	"testing"
)

// TestRebindPlaceholdersForPostgres 是本次改动的核心测试。
//
// 背景:本包用 SQLite 风格的 ? 写 SQL,但 PostgreSQL 只认 $N,
// 而 lib/pq 驱动不做这个转换(驱动按参数个数直接绑定)。
// 所以必须自己把 ? 改写成 $1 $2 ...
func TestRebindPlaceholdersForPostgres(t *testing.T) {
	cases := []struct {
		name  string
		query string
		want  string
	}{
		{
			name:  "单占位符",
			query: `SELECT revision FROM vaults WHERE user_id = ?`,
			want:  `SELECT revision FROM vaults WHERE user_id = $1`,
		},
		{
			name:  "多占位符按序编号",
			query: `UPDATE vaults SET envelope = ?, revision = ? WHERE user_id = ? AND revision = ?`,
			want:  `UPDATE vaults SET envelope = $1, revision = $2 WHERE user_id = $3 AND revision = $4`,
		},
		{
			name:  "insert 六参数",
			query: `INSERT INTO vaults (user_id, envelope, revision, updated_at, device_id, created_at) VALUES (?, ?, 1, ?, ?, ?)`,
			want:  `INSERT INTO vaults (user_id, envelope, revision, updated_at, device_id, created_at) VALUES ($1, $2, 1, $3, $4, $5)`,
		},
		{
			name:  "无占位符原样返回",
			query: `SELECT 1`,
			want:  `SELECT 1`,
		},
		{
			name:  "字符串字面量里的问号不动",
			query: `SELECT * FROM t WHERE a = ? AND b = 'x?y'`,
			want:  `SELECT * FROM t WHERE a = $1 AND b = 'x?y'`,
		},
		{
			name:  "双引号标识符里的问号不动",
			query: `SELECT "we?ird" FROM t WHERE a = ?`,
			want:  `SELECT "we?ird" FROM t WHERE a = $1`,
		},
		{
			name:  "转义单引号内的问号不动",
			query: `INSERT INTO t VALUES (?, 'it''s a? test')`,
			want:  `INSERT INTO t VALUES ($1, 'it''s a? test')`,
		},
		{
			name:  "行注释内的问号不动",
			query: "SELECT 1 -- really? no\nWHERE a = ?",
			want:  "SELECT 1 -- really? no\nWHERE a = $1",
		},
		{
			name:  "块注释内的问号不动",
			query: `SELECT 1 /* what? really */ WHERE a = ?`,
			want:  `SELECT 1 /* what? really */ WHERE a = $1`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := rebindPlaceholders(tc.query, DialectPostgres)
			if got != tc.want {
				t.Errorf("占位符改写错误:\n期望 %q\n得到 %q", tc.want, got)
			}
		})
	}
}

// TestRebindPlaceholdersForSQLitePassThrough 确认 SQLite 走原生 ?,
// 不做任何改写——多改一次就多一个出错的机会。
func TestRebindPlaceholdersForSQLitePassThrough(t *testing.T) {
	query := `SELECT revision FROM vaults WHERE user_id = ?`
	if got := rebindPlaceholders(query, DialectSQLite); got != query {
		t.Errorf("SQLite 不应改写占位符, 得到 %q", got)
	}
}

// TestRebindPlaceholdersNumbersSequentially 确认编号严格从 1 连续递增。
//
// 如果实现里用了"只在第一次替换"之类的错误逻辑,
// 或编号跳号,PG 会报 "there is no parameter $N",而这在测试里就能发现。
func TestRebindPlaceholdersNumbersSequentially(t *testing.T) {
	got := rebindPlaceholders(`VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, DialectPostgres)
	want := `VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`
	if got != want {
		t.Fatalf("编号应连续递增:\n期望 %q\n得到 %q", want, got)
	}
}

// TestSchemaSQLDialectDifferences 确认两种方言的建表语句确实不同。
//
// 它们的差异不只是措辞:SQLite 自增用 INTEGER PRIMARY KEY AUTOINCREMENT,
// PG 用 BIGSERIAL。写错会在建表时就报错。
func TestSchemaSQLDialectDifferences(t *testing.T) {
	sqlite := (&Repository{dialect: DialectSQLite}).schemaSQL()
	pg := (&Repository{dialect: DialectPostgres}).schemaSQL()

	if !strings.Contains(sqlite, "AUTOINCREMENT") {
		t.Errorf("SQLite 建表语句应含 AUTOINCREMENT")
	}
	if strings.Contains(pg, "AUTOINCREMENT") {
		t.Errorf("PG 不支持 AUTOINCREMENT,建表语句不该出现")
	}
	if !strings.Contains(pg, "BIGSERIAL") {
		t.Errorf("PG 建表语句应含 BIGSERIAL")
	}

	// 两边都必须建这两张表,且列名一致——上层 SQL 依赖列名。
	for _, table := range []string{"vaults", "sync_log"} {
		if !strings.Contains(sqlite, table) {
			t.Errorf("SQLite 建表语句缺表 %s", table)
		}
		if !strings.Contains(pg, table) {
			t.Errorf("PG 建表语句缺表 %s", table)
		}
	}
	for _, col := range []string{"user_id", "envelope", "revision", "updated_at", "device_id"} {
		if !strings.Contains(pg, col) {
			t.Errorf("PG 建表语句缺列 %s", col)
		}
	}
}

// TestOpenRejectsUnknownDialect 确认配错数据库类型时明确报错,
// 而不是静默回落到 SQLite——那在生产环境等于把数据写进本地文件。
func TestOpenRejectsUnknownDialect(t *testing.T) {
	_, err := Open(Options{Dialect: Dialect("mysql"), SQLitePath: "x.db"})
	if err == nil {
		t.Fatal("未知数据库类型应报错")
	}
	if !strings.Contains(err.Error(), "sqlite") || !strings.Contains(err.Error(), "postgres") {
		t.Errorf("报错信息应提示可选值, 得到 %q", err.Error())
	}
}

// TestOpenPostgresRequiresDSN 确认 PG 模式缺连接串时立即失败。
func TestOpenPostgresRequiresDSN(t *testing.T) {
	_, err := Open(Options{Dialect: DialectPostgres})
	if err == nil {
		t.Fatal("PG 模式缺连接串应报错")
	}
	if !strings.Contains(err.Error(), "AEGIS_DATABASE_URL") {
		t.Errorf("报错信息应指明环境变量名, 得到 %q", err.Error())
	}
}

// TestIsUniqueViolation 确认唯一键冲突被正确识别。
//
// 并发首发时两个请求会同时 INSERT,后者必须识别为冲突
// 让客户端合并,而不是当成故障报错。
func TestIsUniqueViolation(t *testing.T) {
	if isUniqueViolation(nil) {
		t.Error("nil 不应被判为唯一键冲突")
	}
	if isUniqueViolation(errStringTest("connection refused")) {
		t.Error("普通错误不应被判为唯一键冲突")
	}
	if !isUniqueViolation(errStringTest("UNIQUE constraint failed: vaults.user_id")) {
		t.Error("SQLite 的唯一键冲突应被识别")
	}
	if !isUniqueViolation(errStringTest(`duplicate key value violates unique constraint "vaults_pkey"`)) {
		t.Error("PG 的唯一键冲突应被识别")
	}
}

type errStringTest string

func (e errStringTest) Error() string { return string(e) }
