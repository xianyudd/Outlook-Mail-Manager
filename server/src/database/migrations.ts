import db from './index';

export function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      password TEXT DEFAULT '',
      client_id TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive','error')),
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

    CREATE TABLE IF NOT EXISTS proxies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK(type IN ('socks5','http')),
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      username TEXT DEFAULT '',
      password TEXT DEFAULT '',
      is_default INTEGER DEFAULT 0,
      last_tested_at DATETIME,
      last_test_ip TEXT DEFAULT '',
      status TEXT DEFAULT 'untested' CHECK(status IN ('untested','active','failed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS mail_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      mailbox TEXT NOT NULL DEFAULT 'INBOX' CHECK(mailbox IN ('INBOX','Junk')),
      mail_id TEXT DEFAULT '',
      sender TEXT DEFAULT '',
      sender_name TEXT DEFAULT '',
      subject TEXT DEFAULT '',
      text_content TEXT DEFAULT '',
      html_content TEXT DEFAULT '',
      mail_date DATETIME,
      is_read INTEGER DEFAULT 0,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mail_cache_account ON mail_cache(account_id, mailbox);
    CREATE INDEX IF NOT EXISTS idx_mail_cache_date ON mail_cache(mail_date DESC);

    -- 清理历史重复缓存（仅处理有 mail_id 的记录）
    DELETE FROM mail_cache
    WHERE mail_id <> ''
      AND id NOT IN (
        SELECT MIN(id)
        FROM mail_cache
        WHERE mail_id <> ''
        GROUP BY account_id, mailbox, mail_id
      );

    -- 按业务唯一键去重（忽略历史空 mail_id 记录）
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_cache_unique_nonempty
      ON mail_cache(account_id, mailbox, mail_id)
      WHERE mail_id <> '';

    CREATE TABLE IF NOT EXISTS bulk_mail_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      name TEXT DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'partial_success', 'failed')),
      mailboxes_json TEXT NOT NULL,
      top INTEGER NOT NULL DEFAULT 50,
      batch_size INTEGER NOT NULL DEFAULT 50,
      workers INTEGER NOT NULL DEFAULT 5,
      proxy_id INTEGER,
      total_accounts INTEGER NOT NULL DEFAULT 0,
      processed_accounts INTEGER NOT NULL DEFAULT 0,
      success_accounts INTEGER NOT NULL DEFAULT 0,
      failed_accounts INTEGER NOT NULL DEFAULT 0,
      current_batch INTEGER NOT NULL DEFAULT 0,
      total_batches INTEGER NOT NULL DEFAULT 0,
      inbox_total INTEGER NOT NULL DEFAULT 0,
      junk_total INTEGER NOT NULL DEFAULT 0,
      mail_total INTEGER NOT NULL DEFAULT 0,
      request_id TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      finished_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bulk_mail_jobs_status ON bulk_mail_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_bulk_mail_jobs_created_at ON bulk_mail_jobs(created_at DESC);

    CREATE TABLE IF NOT EXISTS bulk_mail_job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      batch_no INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      account_email TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'success', 'failed')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      mailboxes_json TEXT NOT NULL,
      top INTEGER NOT NULL DEFAULT 50,
      inbox_count INTEGER NOT NULL DEFAULT 0,
      junk_count INTEGER NOT NULL DEFAULT 0,
      fetched_total INTEGER NOT NULL DEFAULT 0,
      request_id TEXT,
      error_code TEXT,
      error_message TEXT,
      started_at DATETIME,
      finished_at DATETIME,
      duration_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES bulk_mail_jobs(job_id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bulk_mail_job_items_unique
      ON bulk_mail_job_items(job_id, account_email);
    CREATE INDEX IF NOT EXISTS idx_bulk_mail_job_items_job ON bulk_mail_job_items(job_id);
    CREATE INDEX IF NOT EXISTS idx_bulk_mail_job_items_job_batch ON bulk_mail_job_items(job_id, batch_no);
    CREATE INDEX IF NOT EXISTS idx_bulk_mail_job_items_job_status ON bulk_mail_job_items(job_id, status);

    CREATE TABLE IF NOT EXISTS bulk_mail_job_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      item_id INTEGER,
      request_id TEXT,
      account_email TEXT,
      level TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
      event TEXT NOT NULL,
      status TEXT,
      error_code TEXT,
      message TEXT,
      meta_json TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (job_id) REFERENCES bulk_mail_jobs(job_id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES bulk_mail_job_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bulk_mail_job_logs_job ON bulk_mail_job_logs(job_id);
    CREATE INDEX IF NOT EXISTS idx_bulk_mail_job_logs_request ON bulk_mail_job_logs(request_id);
    CREATE INDEX IF NOT EXISTS idx_bulk_mail_job_logs_level ON bulk_mail_job_logs(level);
  `);

  // 新增 token_refreshed_at 字段（兼容已有数据库）
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN token_refreshed_at DATETIME`);
  } catch {
    // 字段已存在则忽略
  }

  // 新增 remark 备注字段
  try {
    db.exec(`ALTER TABLE accounts ADD COLUMN remark TEXT DEFAULT ''`);
  } catch {
    // 字段已存在则忽略
  }

  // 标签系统
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#3B82F6',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_tags (
      account_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (account_id, tag_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    )
  `);
}
