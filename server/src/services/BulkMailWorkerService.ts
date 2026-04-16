import { MailService } from './MailService';
import {
  BULK_JOB_CANCELLED_ERROR_CODE,
  BulkMailJobDbStatus,
  BulkMailJobModel,
  BulkMailJobRecord,
} from '../models/BulkMailJob';
import { BulkMailJobItemModel, BulkMailJobItemRecord } from '../models/BulkMailJobItem';
import { BulkMailJobLogModel } from '../models/BulkMailJobLog';
import logger from '../utils/logger';

export class BulkMailWorkerService {
  private runningJobs = new Set<string>();
  private cancelSignals = new Set<string>();
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
        if (errorCode === BULK_JOB_CANCELLED_ERROR_CODE) {
          this.jobModel.cancel(jobId, errorMessage || 'Cancelled by user');
          this.logModel.create({
            job_id: jobId,
            request_id: requestId || null,
            level: 'warn',
            event: 'job_cancelled',
            status: 'cancelled',
            error_code: BULK_JOB_CANCELLED_ERROR_CODE,
            message: errorMessage || 'Cancelled by user',
          });
          logger.warn('bulk_mail_job_cancelled', {
            job_id: jobId,
            request_id: requestId || undefined,
            status: 'cancelled',
            operation: 'bulk_job_cancel',
          });
          return;
        }

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
        this.cancelSignals.delete(jobId);
      });

    return true;
  }

  isRunning(jobId: string): boolean {
    return this.runningJobs.has(jobId);
  }

  requestCancel(jobId: string, requestId: string): boolean {
    const firstSignal = !this.cancelSignals.has(jobId);
    this.cancelSignals.add(jobId);

    logger.warn('bulk_mail_job_cancel_signal', {
      job_id: jobId,
      request_id: requestId || undefined,
      status: 'cancelled',
      operation: 'bulk_job_cancel',
    });

    return firstSignal;
  }

  private async execute(jobId: string, requestId: string): Promise<void> {
    const initialJob = this.jobModel.getByJobId(jobId);
    if (!initialJob) return;
    if (this.shouldStopJob(jobId)) return;

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
      if (this.shouldStopJob(jobId)) {
        break;
      }

      this.jobModel.setCurrentBatch(jobId, batchNo);
      const currentJob = this.jobModel.getByJobId(jobId);
      if (!currentJob) break;
      if (this.shouldStopJob(jobId)) {
        break;
      }

      const items = this.itemModel.listByJobAndBatch(jobId, batchNo);
      await this.runBatch(currentJob, items, requestId || currentJob.request_id || '');
    }

    const finalJob = this.jobModel.getByJobId(jobId);
    if (!finalJob) return;

    if (this.shouldStopJob(jobId)) {
      const cancelledQueuedItems = this.cancelQueuedItems(jobId, requestId || finalJob.request_id || '');
      this.jobModel.cancel(jobId, finalJob.error_message || 'Cancelled by user');
      const cancelledJobSnapshot = this.jobModel.getByJobId(jobId) || finalJob;
      this.logModel.create({
        job_id: jobId,
        request_id: requestId || cancelledJobSnapshot.request_id || null,
        level: 'warn',
        event: 'job_cancelled',
        status: 'cancelled',
        error_code: BULK_JOB_CANCELLED_ERROR_CODE,
        message: cancelledJobSnapshot.error_message || 'Cancelled by user',
      });

      logger.warn('bulk_mail_job_cancelled', {
        job_id: jobId,
        request_id: requestId || cancelledJobSnapshot.request_id || undefined,
        status: 'cancelled',
        cancelled_queued_items: cancelledQueuedItems,
        processed_accounts: cancelledJobSnapshot.processed_accounts,
        success_accounts: cancelledJobSnapshot.success_accounts,
        failed_accounts: cancelledJobSnapshot.failed_accounts,
      });
      return;
    }

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
        if (this.shouldStopJob(job.job_id)) {
          return;
        }

        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await this.processItem(job, items[index], requestId);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runner()));
  }

  private async processItem(job: BulkMailJobRecord, item: BulkMailJobItemRecord, requestId: string): Promise<void> {
    if (this.shouldStopJob(item.job_id)) {
      this.markCancelledBeforeRun(job, item, requestId);
      return;
    }

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
        if (this.shouldStopJob(item.job_id)) {
          throw this.buildCancelError();
        }

        const result = await this.mailService.fetchMails(item.account_id, mailbox, job.proxy_id ?? undefined, item.top, {
          request_id: effectiveRequestId || 'unknown',
          job_id: item.job_id,
          account_id: item.account_id,
          account_email: item.account_email,
          mailbox,
          operation: 'bulk_fetch_mails',
          provider: 'microsoft',
          proxy_id: job.proxy_id ?? undefined,
        });
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

      if (errorCode === BULK_JOB_CANCELLED_ERROR_CODE) {
        this.itemModel.markCancelled(item.id, errorMessage, durationMs);
        this.jobModel.incrementProgress(item.job_id, {
          processed: 1,
        });

        this.logModel.create({
          job_id: item.job_id,
          item_id: item.id,
          request_id: effectiveRequestId || null,
          account_email: item.account_email,
          level: 'warn',
          event: 'item_cancelled',
          status: 'cancelled',
          error_code: errorCode,
          message: errorMessage,
          meta_json: JSON.stringify({ duration_ms: durationMs }),
        });

        logger.warn('bulk_mail_item_cancelled', {
          job_id: item.job_id,
          request_id: effectiveRequestId || undefined,
          account_email: item.account_email,
          status: 'cancelled',
          error_code: errorCode,
          duration_ms: durationMs,
        });
        return;
      }

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
        duration_ms: durationMs,
      });
    }
  }

  private markCancelledBeforeRun(job: BulkMailJobRecord, item: BulkMailJobItemRecord, requestId: string): void {
    const effectiveRequestId = requestId || job.request_id || '';
    const durationMs = 0;
    this.itemModel.markCancelled(item.id, 'Cancelled by user', durationMs);
    this.jobModel.incrementProgress(item.job_id, {
      processed: 1,
    });

    this.logModel.create({
      job_id: item.job_id,
      item_id: item.id,
      request_id: effectiveRequestId || null,
      account_email: item.account_email,
      level: 'warn',
      event: 'item_cancelled',
      status: 'cancelled',
      error_code: BULK_JOB_CANCELLED_ERROR_CODE,
      message: 'Cancelled by user',
      meta_json: JSON.stringify({
        duration_ms: durationMs,
        cancelled_before_run: true,
      }),
    });
  }

  private cancelQueuedItems(jobId: string, requestId: string): number {
    const batchNumbers = this.itemModel.listBatchNumbers(jobId);
    let cancelledCount = 0;

    for (const batchNo of batchNumbers) {
      const items = this.itemModel.listByJobAndBatch(jobId, batchNo);
      for (const item of items) {
        if (item.status !== 'queued') {
          continue;
        }

        this.itemModel.markCancelled(item.id, 'Cancelled by user', 0);
        this.jobModel.incrementProgress(item.job_id, {
          processed: 1,
        });
        this.logModel.create({
          job_id: item.job_id,
          item_id: item.id,
          request_id: requestId || item.request_id || null,
          account_email: item.account_email,
          level: 'warn',
          event: 'item_cancelled',
          status: 'cancelled',
          error_code: BULK_JOB_CANCELLED_ERROR_CODE,
          message: 'Cancelled by user',
          meta_json: JSON.stringify({
            duration_ms: 0,
            cancelled_before_run: true,
          }),
        });

        cancelledCount += 1;
      }
    }

    return cancelledCount;
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

  private shouldStopJob(jobId: string): boolean {
    if (this.cancelSignals.has(jobId)) {
      return true;
    }

    const job = this.jobModel.getByJobId(jobId);
    if (!job) {
      return true;
    }

    return job.status === 'cancelled' || job.error_code === BULK_JOB_CANCELLED_ERROR_CODE;
  }

  private buildCancelError() {
    const error = new Error('Cancelled by user') as Error & { code?: string };
    error.code = BULK_JOB_CANCELLED_ERROR_CODE;
    return error;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private getFinalStatus(job: BulkMailJobRecord): BulkMailJobDbStatus {
    if (job.failed_accounts === 0) return 'completed';
    if (job.success_accounts === 0) return 'failed';
    return 'partial_success';
  }
}

export const bulkMailWorkerService = new BulkMailWorkerService();
