import db from '../database';

export type BulkMailJobItemStatus = 'queued' | 'running' | 'success' | 'failed';

export interface BulkMailJobItemRecord {
  id: number;
  job_id: string;
  batch_no: number;
  account_id: number;
  account_email: string;
  status: BulkMailJobItemStatus;
  retry_count: number;
  mailboxes_json: string;
  top: number;
  inbox_count: number;
  junk_count: number;
  fetched_total: number;
  request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBulkMailJobItemInput {
  job_id: string;
  batch_no: number;
  account_id: number;
  account_email: string;
  status: BulkMailJobItemStatus;
  mailboxes_json: string;
  top: number;
  request_id?: string | null;
}

export class BulkMailJobItemModel {
  bulkCreate(items: CreateBulkMailJobItemInput[]) {
    if (items.length === 0) return;

    const stmt = db.prepare(`
      INSERT OR IGNORE INTO bulk_mail_job_items (
        job_id, batch_no, account_id, account_email, status, mailboxes_json, top, request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = db.transaction((rows: CreateBulkMailJobItemInput[]) => {
      for (const item of rows) {
        stmt.run(
          item.job_id,
          item.batch_no,
          item.account_id,
          item.account_email,
          item.status,
          item.mailboxes_json,
          item.top,
          item.request_id ?? null,
        );
      }
    });

    transaction(items);
  }

  getByJob(jobId: string, page = 1, pageSize = 20) {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const offset = (safePage - 1) * safePageSize;

    const total = (db.prepare('SELECT COUNT(*) as c FROM bulk_mail_job_items WHERE job_id = ?').get(jobId) as { c: number }).c;
    const list = db.prepare(`
      SELECT *
      FROM bulk_mail_job_items
      WHERE job_id = ?
      ORDER BY id ASC
      LIMIT ? OFFSET ?
    `).all(jobId, safePageSize, offset) as BulkMailJobItemRecord[];

    return {
      list,
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  listBatchNumbers(jobId: string): number[] {
    const rows = db.prepare(`
      SELECT DISTINCT batch_no
      FROM bulk_mail_job_items
      WHERE job_id = ?
      ORDER BY batch_no ASC
    `).all(jobId) as Array<{ batch_no: number }>;

    return rows.map((row) => row.batch_no);
  }

  listByJobAndBatch(jobId: string, batchNo: number): BulkMailJobItemRecord[] {
    return db.prepare(`
      SELECT *
      FROM bulk_mail_job_items
      WHERE job_id = ? AND batch_no = ?
      ORDER BY id ASC
    `).all(jobId, batchNo) as BulkMailJobItemRecord[];
  }

  markRunning(id: number, requestId?: string | null) {
    db.prepare(`
      UPDATE bulk_mail_job_items
      SET status = 'running',
          request_id = COALESCE(?, request_id),
          started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(requestId ?? null, id);
  }

  markSuccess(id: number, inboxCount: number, junkCount: number, totalCount: number, durationMs: number) {
    db.prepare(`
      UPDATE bulk_mail_job_items
      SET status = 'success',
          inbox_count = ?,
          junk_count = ?,
          fetched_total = ?,
          error_code = NULL,
          error_message = NULL,
          finished_at = CURRENT_TIMESTAMP,
          duration_ms = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(inboxCount, junkCount, totalCount, durationMs, id);
  }

  markFailed(id: number, errorCode: string, errorMessage: string, durationMs: number) {
    db.prepare(`
      UPDATE bulk_mail_job_items
      SET status = 'failed',
          retry_count = retry_count + 1,
          error_code = ?,
          error_message = ?,
          finished_at = CURRENT_TIMESTAMP,
          duration_ms = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(errorCode, errorMessage, durationMs, id);
  }
}
