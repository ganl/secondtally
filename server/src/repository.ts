/**
 * 同步存储层。
 *
 * 最重要的设计约束:这个表里只允许出现密文。
 * 任何试图写入明文字段的代码路径都不应该存在——
 * 服务端被脱库时,攻击者拿到的必须是一堆无法解读的十六进制串。
 *
 * 选用 SQLite 的理由:单文件、零运维、易备份。
 * 若后期要多实例横向扩展,把 repository 换成 Postgres 即可,
 * 上层 service 与路由无需改动(接口保持一致)。
 */

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * 极简 SQLite 访问层。
 * 优先用 node:sqlite(Node 22+ 内置),否则回退到 better-sqlite3。
 * 两者接口足够接近,这里只封装用到的部分。
 */
function openDatabase(file: string) {
  mkdirSync(dirname(file), { recursive: true });

  // Node 22.5+ 内置
  try {
    const { DatabaseSync } = require('node:sqlite');
    return { db: new DatabaseSync(file), kind: 'node:sqlite' };
  } catch {
    /* 继续尝试 */
  }

  try {
    const Database = require('better-sqlite3');
    return { db: new Database(file), kind: 'better-sqlite3' };
  } catch (error) {
    throw new Error(
      '缺少 SQLite 驱动。请使用 Node 22.5+ 内置的 node:sqlite,或安装 better-sqlite3。' +
        `原始错误: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface StoredVault {
  userId: string;
  envelope: string;
  revision: number;
  updatedAt: number;
  deviceId: string;
}

export class VaultRepository {
  private readonly db: { exec: (s: string) => void; prepare: (s: string) => any; close?: () => void };
  private readonly findStmt: { get: (id: string) => any };
  private readonly updateStmt: {
    run: (envelope: string, updatedAt: number, deviceId: string, revision: number, userId: string, baseRevision: number) => any;
  };
  private readonly insertStmt: {
    run: (userId: string, envelope: string, updatedAt: number, deviceId: string, createdAt: number) => any;
  };

  constructor(private readonly file: string) {
    const opened = openDatabase(file);
    this.db = opened.db as any;
    this.init();
    this.findStmt = this.db.prepare('SELECT * FROM vaults WHERE user_id = ?');
    this.updateStmt = this.db.prepare(`
      UPDATE vaults
         SET envelope = ?, updated_at = ?, device_id = ?, revision = ?
       WHERE user_id = ? AND revision = ?
    `);
    this.insertStmt = this.db.prepare(`
      INSERT INTO vaults (user_id, envelope, revision, updated_at, device_id, created_at)
      VALUES (?, ?, 1, ?, ?, ?)
    `);
  }

  private run(sql: string) {
    this.db.exec(sql);
  }

  private init() {
    this.run(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS vaults (
        user_id     TEXT PRIMARY KEY,
        envelope    TEXT NOT NULL,
        revision    INTEGER NOT NULL DEFAULT 1,
        updated_at  INTEGER NOT NULL,
        device_id   TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      -- 审计:服务端只记"谁在什么时候同步了多少字节",
      -- 绝不记录内容,否则服务端就成了明文泄漏点。
      CREATE TABLE IF NOT EXISTS sync_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        revision    INTEGER NOT NULL,
        bytes       INTEGER NOT NULL,
        at          INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sync_log_user ON sync_log(user_id, at DESC);
    `);
  }


  get(userId: string): StoredVault | null {
    const row = this.findStmt.get(userId) as any;
    if (!row) return null;
    return {
      userId: row.user_id,
      envelope: row.envelope,
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at),
      deviceId: row.device_id,
    };
  }

  /**
   * 条件写入。
   * baseRevision 为 null 表示"必须不存在才写入"(首次上传)。
   * 返回 null 表示条件不满足,调用方应转为冲突而非覆盖。
   */
  put(
    userId: string,
    envelope: string,
    updatedAt: number,
    deviceId: string,
    baseRevision: number | null,
  ): { ok: true; revision: number } | { ok: false } {
    const current = this.get(userId);

    if (current === null) {
      if (baseRevision !== null) return { ok: false };
      this.insertStmt.run(userId, envelope, updatedAt, deviceId, Date.now());
      this.log(userId, deviceId, 1, envelope.length, updatedAt);
      return { ok: true, revision: 1 };
    }

    if (baseRevision === null || baseRevision !== current.revision) {
      return { ok: false };
    }

    const nextRevision = current.revision + 1;
    this.updateStmt.run(envelope, updatedAt, deviceId, nextRevision, userId, baseRevision);
    this.log(userId, deviceId, nextRevision, envelope.length, updatedAt);
    return { ok: true, revision: nextRevision };
  }

  private log(userId: string, deviceId: string, revision: number, bytes: number, at: number) {
    this.db
      .prepare('INSERT INTO sync_log (user_id, device_id, revision, bytes, at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, deviceId, revision, bytes, at);
  }

  recentSyncs(userId: string, limit = 20) {
    return this.db
      .prepare('SELECT device_id, revision, bytes, at FROM sync_log WHERE user_id = ? ORDER BY at DESC LIMIT ?')
      .all(userId, limit)
      .map((row: any) => ({
        deviceId: row.device_id,
        revision: Number(row.revision),
        bytes: Number(row.bytes),
        at: Number(row.at),
      }));
  }

  close() {
    this.db.close?.();
  }
}
