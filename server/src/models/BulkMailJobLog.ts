import db from '../database';
import { auditService } from '../services/AuditService';

export interface BulkMailJobLogRecord {
  id: number;
  job_id: string;
  item_id: number | null;
  request_id: string | null;
  account_email: string | null;
  level: 'info' | 'warn' | 'error';
  event: string;
  status: string | null;
  error_code: string | null;
  message: string | null;
  meta_json: string | null;
  created_at: string;
}

export interface CreateBulkMailJobLogInput {
  job_id: string;
  item_id?: number | null;
  request_id?: string | null;
  account_email?: string | null;
  level: 'info' | 'warn' | 'error';
  event: string;
  status?: string | null;
  error_code?: string | null;
  message?: string | null;
  meta_json?: string | null;
}

export class BulkMailJobLogModel {
  create(input: CreateBulkMailJobLogInput) {
    db.prepare(`
      INSERT INTO bulk_mail_job_logs (
        job_id, item_id, request_id, account_email, level, event,
        status, error_code, message, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.job_id,
      input.item_id ?? null,
      input.request_id ?? null,
      input.account_email ?? null,
      input.level,
      input.event,
      input.status ?? null,
      input.error_code ?? null,
      input.message ?? null,
      input.meta_json ?? '{}',
    );

    auditService.writeFromBulkJobLog({
      job_id: input.job_id,
      request_id: input.request_id ?? null,
      account_email: input.account_email ?? null,
      event: input.event,
      status: input.status ?? null,
      error_code: input.error_code ?? null,
      message: input.message ?? null,
      meta_json: input.meta_json ?? null,
    });
  }

  getByJob(jobId: string, page = 1, pageSize = 50) {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.max(1, Math.floor(pageSize));
    const offset = (safePage - 1) * safePageSize;

    const total = (db.prepare('SELECT COUNT(*) as c FROM bulk_mail_job_logs WHERE job_id = ?').get(jobId) as { c: number }).c;
    const list = db.prepare(`
      SELECT *
      FROM bulk_mail_job_logs
      WHERE job_id = ?
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(jobId, safePageSize, offset) as BulkMailJobLogRecord[];

    return {
      list,
      total,
      page: safePage,
      pageSize: safePageSize,
    };
  }
}
