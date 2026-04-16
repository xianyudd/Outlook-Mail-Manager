import { MailService } from './MailService';
import { BulkMailJobModel, BulkMailJobRecord, BulkMailJobStatus } from '../models/BulkMailJob';
import { BulkMailJobItemModel, BulkMailJobItemRecord } from '../models/BulkMailJobItem';
import { BulkMailJobLogModel } from '../models/BulkMailJobLog';
import logger from '../utils/logger';

export class BulkMailWorkerService {
  private runningJobs = new Set<string>();
  private mailService = new MailService();
  private jobModel = new BulkMailJobModel();
  private itemModel = new BulkMailJobItemModel();
  private logModel = new BulkMailJobLogModel();

  start(jobId: string, requestId: string): boolean {
    if (this.runningJobs.has(jobId)) {
      return false;
    }

    this.runningJobs.add(jobId);

    void this.execute(jobId, requestId)
      .catch((error: unknown) => {
        const errorCode = this.getErrorCode(error);
        const errorMessage = this.getErrorMessage(error);
        this.jobModel.finalize(jobId, 'failed', errorCode, errorMessage);
        this.logModel.create({
          job_id: jobId,
          request_id: requestId || null,
          level: 'error',
          event: 'job_failed',
          status: 'failed',
          error_code: errorCode,
          message: errorMessage,
        });
        logger.error('bulk_mail_job_failed', {
          job_id: jobId,
          request_id: requestId || undefined,
          status: 'failed',
          error_code: errorCode,
        });
      })
      .finally(() => {
        this.runningJobs.delete(jobId);
      });

    return true;
  }

  isRunning(jobId: string): boolean {
    return this.runningJobs.has(jobId);
  }

  private async execute(jobId: string, requestId: string): Promise<void> {
    const initialJob = this.jobModel.getByJobId(jobId);
    if (!initialJob) return;

    this.jobModel.setRunning(jobId);
    this.logModel.create({
      job_id: jobId,
      request_id: requestId || initialJob.request_id || null,
      level: 'info',
      event: 'job_started',
      status: 'running',
      message: 'Bulk mail worker started',
    });

    logger.info('bulk_mail_job_started', {
      job_id: jobId,
      request_id: requestId || initialJob.request_id || undefined,
      status: 'running',
    });

    const batchNumbers = this.itemModel.listBatchNumbers(jobId);

    for (const batchNo of batchNumbers) {
      this.jobModel.setCurrentBatch(jobId, batchNo);
      const currentJob = this.jobModel.getByJobId(jobId);
      if (!currentJob) break;

      const items = this.itemModel.listByJobAndBatch(jobId, batchNo);
      await this.runBatch(currentJob, items, requestId || currentJob.request_id || '');
    }

    const finalJob = this.jobModel.getByJobId(jobId);
    if (!finalJob) return;

    const finalStatus = this.getFinalStatus(finalJob);
    this.jobModel.finalize(jobId, finalStatus);

    this.logModel.create({
      job_id: jobId,
      request_id: requestId || finalJob.request_id || null,
      level: 'info',
      event: 'job_completed',
      status: finalStatus,
      message: 'Bulk mail worker completed',
      meta_json: JSON.stringify({
        total_accounts: finalJob.total_accounts,
        success_accounts: finalJob.success_accounts,
        failed_accounts: finalJob.failed_accounts,
      }),
    });

    logger.info('bulk_mail_job_completed', {
      job_id: jobId,
      request_id: requestId || finalJob.request_id || undefined,
      status: finalStatus,
      processed_accounts: finalJob.processed_accounts,
      success_accounts: finalJob.success_accounts,
      failed_accounts: finalJob.failed_accounts,
    });
  }

  private async runBatch(job: BulkMailJobRecord, items: BulkMailJobItemRecord[], requestId: string): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const workerCount = Math.max(1, Math.min(job.workers, items.length));
    let cursor = 0;

    const runner = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await this.processItem(job, items[index], requestId);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runner()));
  }

  private async processItem(job: BulkMailJobRecord, item: BulkMailJobItemRecord, requestId: string): Promise<void> {
    const startedAtMs = Date.now();
    const effectiveRequestId = requestId || job.request_id || '';

    this.itemModel.markRunning(item.id, effectiveRequestId || null);
    this.logModel.create({
      job_id: item.job_id,
      item_id: item.id,
      request_id: effectiveRequestId || null,
      account_email: item.account_email,
      level: 'info',
      event: 'item_started',
      status: 'running',
    });

    logger.info('bulk_mail_item_started', {
      job_id: item.job_id,
      request_id: effectiveRequestId || undefined,
      account_email: item.account_email,
      status: 'running',
    });

    const mailboxes = this.parseMailboxes(item.mailboxes_json);
    let inboxCount = 0;
    let junkCount = 0;
    let totalCount = 0;

    try {
      for (const mailbox of mailboxes) {
        const result = await this.mailService.fetchMails(item.account_id, mailbox, job.proxy_id ?? undefined, item.top);
        const fetchedCount = Number.isFinite(result.total) ? result.total : result.mails.length;
        if (mailbox === 'INBOX') inboxCount += fetchedCount;
        if (mailbox === 'Junk') junkCount += fetchedCount;
        totalCount += fetchedCount;
      }

      const durationMs = Date.now() - startedAtMs;
      this.itemModel.markSuccess(item.id, inboxCount, junkCount, totalCount, durationMs);
      this.jobModel.incrementProgress(item.job_id, {
        processed: 1,
        success: 1,
        inbox: inboxCount,
        junk: junkCount,
        total: totalCount,
      });

      this.logModel.create({
        job_id: item.job_id,
        item_id: item.id,
        request_id: effectiveRequestId || null,
        account_email: item.account_email,
        level: 'info',
        event: 'item_completed',
        status: 'success',
        message: 'Mail fetch completed',
        meta_json: JSON.stringify({
          inbox_count: inboxCount,
          junk_count: junkCount,
          fetched_total: totalCount,
          duration_ms: durationMs,
        }),
      });

      logger.info('bulk_mail_item_completed', {
        job_id: item.job_id,
        request_id: effectiveRequestId || undefined,
        account_email: item.account_email,
        status: 'success',
        inbox_count: inboxCount,
        junk_count: junkCount,
        fetched_total: totalCount,
      });
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAtMs;
      const errorCode = this.getErrorCode(error);
      const errorMessage = this.getErrorMessage(error);

      this.itemModel.markFailed(item.id, errorCode, errorMessage, durationMs);
      this.jobModel.incrementProgress(item.job_id, {
        processed: 1,
        failed: 1,
      });

      this.logModel.create({
        job_id: item.job_id,
        item_id: item.id,
        request_id: effectiveRequestId || null,
        account_email: item.account_email,
        level: 'error',
        event: 'item_failed',
        status: 'failed',
        error_code: errorCode,
        message: errorMessage,
        meta_json: JSON.stringify({ duration_ms: durationMs }),
      });

      logger.error('bulk_mail_item_failed', {
        job_id: item.job_id,
        request_id: effectiveRequestId || undefined,
        account_email: item.account_email,
        status: 'failed',
        error_code: errorCode,
      });
    }
  }

  private parseMailboxes(raw: string): Array<'INBOX' | 'Junk'> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return ['INBOX', 'Junk'];

      const normalized = parsed
        .map((item) => String(item || '').trim())
        .map((item) => item.toUpperCase() === 'JUNK' ? 'Junk' : item.toUpperCase())
        .filter((item) => item === 'INBOX' || item === 'Junk') as Array<'INBOX' | 'Junk'>;

      if (normalized.length === 0) {
        return ['INBOX', 'Junk'];
      }

      return Array.from(new Set(normalized));
    } catch {
      return ['INBOX', 'Junk'];
    }
  }

  private getErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && code.trim()) return code;
    }
    return 'BULK_FETCH_ERROR';
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private getFinalStatus(job: BulkMailJobRecord): BulkMailJobStatus {
    if (job.failed_accounts === 0) return 'completed';
    if (job.success_accounts === 0) return 'failed';
    return 'partial_success';
  }
}

export const bulkMailWorkerService = new BulkMailWorkerService();
