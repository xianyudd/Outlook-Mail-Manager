import db from '../database';

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
  }
}
