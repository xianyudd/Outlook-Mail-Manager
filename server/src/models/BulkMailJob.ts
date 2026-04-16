import db from '../database';

export const BULK_JOB_CANCELLED_ERROR_CODE = 'BULK_JOB_CANCELLED';

export type BulkMailJobDbStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed' | 'cancelled';
export type BulkMailJobStatus = BulkMailJobDbStatus;

export interface BulkMailJobRecord {
  id: number;
  job_id: string;
  name: string;
  status: BulkMailJobDbStatus;
  mailboxes_json: string;
  top: number;
  batch_size: number;
  workers: number;
  proxy_id: number | null;
  total_accounts: number;
  processed_accounts: number;
  success_accounts: number;
  failed_accounts: number;
  current_batch: number;
  total_batches: number;
  inbox_total: number;
  junk_total: number;
  mail_total: number;
  request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface CreateBulkMailJobInput {
  job_id: string;
  name: string;
  status: BulkMailJobDbStatus;
  mailboxes_json: string;
  top: number;
  batch_size: number;
  workers: number;
  proxy_id?: number | null;
  total_accounts: number;
  total_batches: number;
  request_id?: string | null;
}

export interface BulkMailJobProgressDelta {
  processed?: number;
  success?: number;
  failed?: number;
  inbox?: number;
  junk?: number;
  total?: number;
}

export class BulkMailJobModel {
  create(input: CreateBulkMailJobInput): BulkMailJobRecord {
    db.prepare(
      `INSERT INTO bulk_mail_jobs (
        job_id, name, status, mailboxes_json, top, batch_size, workers, proxy_id,
        total_accounts, total_batches, request_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.job_id,
      input.name,
      input.status,
      input.mailboxes_json,
      input.top,
      input.batch_size,
      input.workers,
      input.proxy_id ?? null,
      input.total_accounts,
      input.total_batches,
      input.request_id ?? null,
    );

    return this.getByJobId(input.job_id)!;
  }

  getByJobId(jobId: string): BulkMailJobRecord | undefined {
    return db.prepare('SELECT * FROM bulk_mail_jobs WHERE job_id = ?').get(jobId) as BulkMailJobRecord | undefined;
  }

  setRunning(jobId: string) {
    db.prepare(`
      UPDATE bulk_mail_jobs
      SET status = 'running',
          started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(jobId);
  }

  setCurrentBatch(jobId: string, batchNo: number) {
    db.prepare(`
      UPDATE bulk_mail_jobs
      SET current_batch = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(batchNo, jobId);
  }

  incrementProgress(jobId: string, delta: BulkMailJobProgressDelta) {
    db.prepare(`
      UPDATE bulk_mail_jobs
      SET processed_accounts = processed_accounts + ?,
          success_accounts = success_accounts + ?,
          failed_accounts = failed_accounts + ?,
          inbox_total = inbox_total + ?,
          junk_total = junk_total + ?,
          mail_total = mail_total + ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(
      delta.processed ?? 0,
      delta.success ?? 0,
      delta.failed ?? 0,
      delta.inbox ?? 0,
      delta.junk ?? 0,
      delta.total ?? 0,
      jobId,
    );
  }

  finalize(jobId: string, status: BulkMailJobDbStatus, errorCode?: string | null, errorMessage?: string | null) {
    db.prepare(`
      UPDATE bulk_mail_jobs
      SET status = ?,
          error_code = ?,
          error_message = ?,
          finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE job_id = ?
    `).run(status, errorCode ?? null, errorMessage ?? null, jobId);
  }

  cancel(jobId: string, reason = 'Cancelled by user') {
    try {
      db.prepare(`
        UPDATE bulk_mail_jobs
        SET status = 'cancelled',
            error_code = ?,
            error_message = ?,
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
      `).run(BULK_JOB_CANCELLED_ERROR_CODE, reason, jobId);
      return;
    } catch {
      // 兼容旧库状态约束不含 cancelled 的场景，回退为 failed + 取消错误码
      db.prepare(`
        UPDATE bulk_mail_jobs
        SET status = 'failed',
            error_code = ?,
            error_message = ?,
            finished_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE job_id = ?
      `).run(BULK_JOB_CANCELLED_ERROR_CODE, reason, jobId);
    }
  }
}
