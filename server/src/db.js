import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * 数据访问层 —— 基于 Node 内置 SQLite(node:sqlite), 无需任何原生依赖。
 *
 * 表结构:
 *   works    作品(仓库元数据 + 发布/构建状态)
 *   builds   构建记录(与提交 sha 绑定: 一次构建 = 一个提交)
 *   creators 创作者(账号: 用户名 + 密码哈希 + 邮箱验证 + 资料)
 *   verify_tokens 邮箱验证令牌(注册验证 / 换绑邮箱)
 *
 * 平台规则(构建与 Git Commit 绑定):
 *   - 每次 main 推送触发一次构建, 构建结果记录到 builds 表并绑定该提交 sha
 *   - works.build_status 是最近一次处理的 main 推送的构建状态(冗余, 便于列表展示)
 *   - 只有 main 分支存在"构建成功"提交的作品, 才会出现在他人的主页上
 */
export function createDb(cfg) {
  fs.mkdirSync(path.dirname(cfg.dbFile), { recursive: true });
  const db = new DatabaseSync(cfg.dbFile);

  /** 幂等迁移: 给表补列(旧库升级) */
  function migrateColumns(table, columns) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    return columns
      .filter(([name]) => !existing.has(name))
      .map(([name, def]) => `ALTER TABLE ${table} ADD COLUMN ${name} ${def};`)
      .join('\n');
  }
  db.exec('PRAGMA journal_mode = WAL;');   // WAL: 并发读写更稳(测试会开第二个连接)
  db.exec('PRAGMA busy_timeout = 5000;');
  // 基础表: 先建表, 再算迁移(迁移需要表已存在才能查 PRAGMA table_info)
  db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      id            TEXT PRIMARY KEY,             -- 作品 ID(同时是仓库目录名)
      title         TEXT NOT NULL,                -- 标题
      description   TEXT NOT NULL DEFAULT '',     -- 简介
      creator       TEXT NOT NULL,                -- 创作者名称
      created_at    INTEGER NOT NULL,             -- 创建时间(ms)
      last_update   INTEGER NOT NULL DEFAULT 0,   -- 最近一次发布(main 推送)时间(ms)
      published_sha TEXT,                         -- main 分支最近一次提交(空 = 从未发布, 即草稿)
      build_status  TEXT NOT NULL DEFAULT 'none', -- none | building | success | failed
      build_log     TEXT NOT NULL DEFAULT ''      -- 最近一次构建日志
    );
    CREATE TABLE IF NOT EXISTS builds (
      work_id    TEXT NOT NULL,             -- 作品 ID
      sha        TEXT NOT NULL,             -- 绑定的提交 sha(main 分支)
      status     TEXT NOT NULL,             -- building | success | failed
      log        TEXT NOT NULL DEFAULT '',  -- 构建日志
      created_at INTEGER NOT NULL,          -- 首次构建时间
      updated_at INTEGER NOT NULL,          -- 最近一次(重新)构建时间
      PRIMARY KEY (work_id, sha)
    );
    CREATE INDEX IF NOT EXISTS idx_builds_work ON builds(work_id);
    CREATE TABLE IF NOT EXISTS creators (
      name       TEXT PRIMARY KEY,
      token      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      password_hash TEXT,              -- NULL = 早期免密账号(需设置密码后才能登录)
      email      TEXT,                 -- 已验证的邮箱(换绑/重新验证前保持旧值或 NULL)
      email_verified INTEGER NOT NULL DEFAULT 0,
      nickname   TEXT,                 -- 昵称(默认 = 用户名)
      bio        TEXT NOT NULL DEFAULT '',
      avatar     TEXT NOT NULL DEFAULT ''  -- 头像 emoji(默认按用户名生成)
    );
    CREATE TABLE IF NOT EXISTS verify_tokens (
      token      TEXT PRIMARY KEY,
      creator    TEXT NOT NULL,
      kind       TEXT NOT NULL,        -- register | change_email
      email      TEXT NOT NULL,        -- 待验证的邮箱
      created_at INTEGER NOT NULL
    );

    -- 邮箱唯一(已验证邮箱不可重复; SQLite 部分索引, NULL 互不冲突)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_email
      ON creators(email) WHERE email IS NOT NULL AND email != '';

    -- 迁移: 旧版本把构建状态存在 works 表, 回填为 builds 记录(绑定到发布提交),
    -- 使"构建成功才公开"规则对存量作品同样生效。
    INSERT OR IGNORE INTO builds (work_id, sha, status, log, created_at, updated_at)
      SELECT id, published_sha, build_status, build_log, last_update, last_update
      FROM works
      WHERE published_sha IS NOT NULL AND build_status IN ('success', 'failed');
  `);

  // 迁移: 旧版本 creators 表没有账号字段, 逐列补齐(幂等; 此时表已存在)
  const migrateSql = migrateColumns('creators', [
    ['password_hash', 'TEXT'],
    ['email', 'TEXT'],
    ['email_verified', 'INTEGER NOT NULL DEFAULT 0'],
    ['nickname', 'TEXT'],
    ['bio', "TEXT NOT NULL DEFAULT ''"],
    ['avatar', "TEXT NOT NULL DEFAULT ''"],
  ]);
  if (migrateSql) db.exec(migrateSql);

    const toUser = (r) =>
      r && {
        name: r.name,
        nickname: r.nickname || r.name,
        email: r.email || '',
        emailVerified: !!r.email_verified,
        bio: r.bio || '',
        avatar: r.avatar || '',
        createdAt: r.created_at,
        hasPassword: !!r.password_hash,
      };

    /** 数据库行 -> 对外返回对象 的映射(蛇形列名 -> 驼峰字段) */
  const toWork = (r) =>
    r && {
      id: r.id,
      title: r.title,
      description: r.description,
      creator: r.creator,
      createdAt: r.created_at,
      lastUpdate: r.last_update,
      publishedSha: r.published_sha,
      buildStatus: r.build_status,
      buildLog: r.build_log,
    };

  return {
    /** 关闭连接(服务退出 / 测试清理时调用, 释放文件句柄) */
    close() {
      db.close();
    },

    // ---------------- 作品 ----------------

    getWork(id) {
      return toWork(db.prepare('SELECT * FROM works WHERE id = ?').get(id));
    },

    /**
     * 主页作品流(他人可见): 最近 N 天内有更新的作品, 且 main 分支存在
     * 至少一个"构建成功"的提交 —— 构建与提交绑定, 没有有效构建就不公开。
     * 按更新时间倒序, 刻意不提供任何热度字段(人人平等曝光)。
     */
    listPublishedSince(since) {
      return db
        .prepare(
          `SELECT * FROM works
           WHERE published_sha IS NOT NULL AND last_update >= ?
             AND EXISTS (SELECT 1 FROM builds b WHERE b.work_id = works.id AND b.status = 'success')
           ORDER BY last_update DESC`,
        )
        .all(since)
        .map(toWork);
    },

    /** 全部已公开作品(不分时间窗口): main 存在构建成功提交 */
    listPublished() {
      return db
        .prepare(
          `SELECT * FROM works
           WHERE published_sha IS NOT NULL
             AND EXISTS (SELECT 1 FROM builds b WHERE b.work_id = works.id AND b.status = 'success')
           ORDER BY last_update DESC`,
        )
        .all()
        .map(toWork);
    },

    /** 某创作者已发布(存在有效构建)的作品 —— 公开个人主页用 */
    listPublishedByCreator(creator) {
      return db
        .prepare(
          `SELECT * FROM works
           WHERE creator = ? AND published_sha IS NOT NULL
             AND EXISTS (SELECT 1 FROM builds b WHERE b.work_id = works.id AND b.status = 'success')
           ORDER BY last_update DESC`,
        )
        .all(creator)
        .map(toWork);
    },

    /** 某创作者的全部作品(含未发布的草稿) */
    listWorksByCreator(creator) {
      return db
        .prepare('SELECT * FROM works WHERE creator = ? ORDER BY created_at DESC')
        .all(creator)
        .map(toWork);
    },

    createWork({ id, title, description, creator }) {
      db.prepare(
        'INSERT INTO works (id, title, description, creator, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(id, title, description, creator, Date.now());
      return this.getWork(id);
    },

    /** 更新标题/简介(不改变 last_update —— 只有 main 推送才算一次更新) */
    updateMeta(id, { title, description }) {
      db.prepare(
        'UPDATE works SET title = COALESCE(?, title), description = COALESCE(?, description) WHERE id = ?',
      ).run(title ?? null, description ?? null, id);
    },

    deleteWork(id) {
      db.prepare('DELETE FROM builds WHERE work_id = ?').run(id);
      db.prepare('DELETE FROM works WHERE id = ?').run(id);
    },

    /**
     * 记录一次构建并绑定到提交 sha(同时刷新 works 表的最新状态, 便于列表展示)。
     * sha 为空(如 main 分支被删除)时只更新 works 表。
     */
    setBuild(id, sha, status, log) {
      if (sha) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO builds (work_id, sha, status, log, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(work_id, sha) DO UPDATE SET
             status = excluded.status, log = excluded.log, updated_at = excluded.updated_at`,
        ).run(id, sha, status, log ?? '', now, now);
      }
      db.prepare('UPDATE works SET build_status = ?, build_log = ? WHERE id = ?').run(
        status,
        log ?? '',
        id,
      );
    },

    /**
     * main 被推送时调用: 记录更新时间 + 最新发布提交 + 构建结果(绑定到该提交)。
     * 无论构建成败都算一次更新(更新时间刷新); 是否公开由"存在有效构建"决定。
     */
    touchUpdate(id, { sha, status, log }) {
      db.prepare('UPDATE works SET published_sha = ?, last_update = ? WHERE id = ?').run(
        sha,
        Date.now(),
        id,
      );
      this.setBuild(id, sha, status, log);
    },

    /** 最近一次构建记录(任意状态; 正常情况下就是发布提交的构建) */
    latestBuild(id) {
      return db
        .prepare('SELECT * FROM builds WHERE work_id = ? ORDER BY updated_at DESC LIMIT 1')
        .get(id);
    },

    /** 最近一次构建成功的提交记录(用于"显示最近一次有效构建") */
    latestValidBuild(id) {
      return db
        .prepare("SELECT * FROM builds WHERE work_id = ? AND status = 'success' ORDER BY updated_at DESC LIMIT 1")
        .get(id);
    },

    /** main 分支是否至少存在一个构建成功的提交 */
    hasValidBuild(id) {
      return !!db
        .prepare("SELECT 1 FROM builds WHERE work_id = ? AND status = 'success' LIMIT 1")
        .get(id);
    },

    /** 仅测试使用: 直接改写更新时间, 用于验证主页 30 天收录规则 */
    setLastUpdateRaw(id, ts) {
      db.prepare('UPDATE works SET last_update = ? WHERE id = ?').run(ts, id);
    },

    /** 上次进程退出时未完成构建的作品(排队中/构建中) —— 启动恢复用 */
    listInterrupted() {
      return db
        .prepare("SELECT * FROM works WHERE build_status IN ('queued', 'building')")
        .all()
        .map(toWork);
    },

    // ---------------- 创作者(账号) ----------------

    getUser(name) {
      return db.prepare('SELECT * FROM creators WHERE name = ?').get(name);
    },

    getUserByEmail(email) {
      return db
        .prepare("SELECT * FROM creators WHERE email = ? AND email_verified = 1")
        .get(email);
    },

    getCreator(name) {
      return db.prepare('SELECT * FROM creators WHERE name = ?').get(name);
    },

    createCreator(name, token) {
      db.prepare('INSERT INTO creators (name, token, created_at) VALUES (?, ?, ?)').run(
        name,
        token,
        Date.now(),
      );
      return this.getCreator(name);
    },

    findByToken(token) {
      return db.prepare('SELECT * FROM creators WHERE token = ?').get(token);
    },

    /** 注册: 用户名 + 密码哈希(邮箱待验证, 验证通过后写入) */
    registerUser({ name, passwordHash }) {
      db.prepare(
        'INSERT INTO creators (name, token, password_hash, nickname, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(name, crypto.randomBytes(24).toString('hex'), passwordHash, name, Date.now());
      return this.getUser(name);
    },

    /** 设置/更新密码(legacy 账号首次设置, 或修改密码后轮换 token 使旧会话失效) */
    setPassword(name, passwordHash) {
      db.prepare(
        'UPDATE creators SET password_hash = ?, token = ? WHERE name = ?',
      ).run(passwordHash, crypto.randomBytes(24).toString('hex'), name);
      return this.getUser(name);
    },

    updateProfile(name, { nickname, bio, avatar }) {
      db.prepare(
        `UPDATE creators SET
           nickname = COALESCE(?, nickname),
           bio      = COALESCE(?, bio),
           avatar   = COALESCE(?, avatar)
         WHERE name = ?`,
      ).run(nickname ?? null, bio ?? null, avatar ?? null, name);
    },

    /** 邮箱验证通过后落库(注册验证 / 换绑共用) */
    bindEmail(name, email) {
      db.prepare('UPDATE creators SET email = ?, email_verified = 1 WHERE name = ?').run(
        email,
        name,
      );
    },

    // ---------------- 邮箱验证令牌 ----------------

    insertVerifyToken({ token, creator, kind, email }) {
      db.prepare(
        'INSERT INTO verify_tokens (token, creator, kind, email, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(token, creator, kind, email, Date.now());
    },

    getVerifyToken(token) {
      return db.prepare('SELECT * FROM verify_tokens WHERE token = ?').get(token);
    },

    deleteVerifyToken(token) {
      db.prepare('DELETE FROM verify_tokens WHERE token = ?').run(token);
    },

    /** 清理过期令牌(验证时顺带) */
    purgeVerifyTokens(olderThanMs) {
      db.prepare('DELETE FROM verify_tokens WHERE created_at < ?').run(olderThanMs);
    },

    /** 该账号已有的未过期验证令牌(换绑时防重复发送) */
    latestVerifyToken(creator, kind) {
      return db
        .prepare('SELECT * FROM verify_tokens WHERE creator = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
        .get(creator, kind);
    },
  };
}

