import crypto from 'crypto';
import { AccountModel } from '../models/Account';
import {
  BULK_JOB_CANCELLED_ERROR_CODE,
  BulkMailJobModel,
  BulkMailJobRecord,
  BulkMailJobStatus,
} from '../models/BulkMailJob';
import { BulkMailJobItemModel } from '../models/BulkMailJobItem';
import { BulkMailJobLogModel } from '../models/BulkMailJobLog';
import { bulkMailWorkerService } from './BulkMailWorkerService';
import logger from '../utils/logger';
import { auditService, AuditActions } from './AuditService';

interface CreateBulkMailJobPayload {
  name?: string;
  account_ids?: number[];
  mailboxes?: string[];
  top?: number;
  batch_size?: number;
  workers?: number;
  proxy_id?: number;
}

export class BulkMailJobService {
  private accountModel = new AccountModel();
  private jobModel = new BulkMailJobModel();
  private itemModel = new BulkMailJobItemModel();
  private logModel = new BulkMailJobLogModel();

  createAndStart(payload: CreateBulkMailJobPayload, requestId: string): BulkMailJobRecord {
    const mailboxes = this.normalizeMailboxes(payload.mailboxes);
    const top = this.parsePositiveInt(payload.top, 50);
    const batchSize = this.parsePositiveInt(payload.batch_size, 50);
    const workers = this.parsePositiveInt(payload.workers, 5);
    const proxyId = Number.isFinite(payload.proxy_id) ? Number(payload.proxy_id) : null;

    const accounts = this.resolveAccounts(payload.account_ids);
    if (accounts.length === 0) {
      throw new Error('No available accounts to create bulk job');
    }

    const jobId = this.generateJobId();
    const totalBatches = Math.max(1, Math.ceil(accounts.length / batchSize));
    const jobName = (payload.name || '').trim() || `bulk_mail_pull_${new Date().toISOString()}`;

    this.jobModel.create({
      job_id: jobId,
      name: jobName,
      status: 'queued',
      mailboxes_json: JSON.stringify(mailboxes),
      top,
      batch_size: batchSize,
      workers,
      proxy_id: proxyId,
      total_accounts: accounts.length,
      total_batches: totalBatches,
      request_id: requestId || null,
    });

    this.itemModel.bulkCreate(
      accounts.map((account, index) => ({
        job_id: jobId,
        batch_no: Math.floor(index / batchSize) + 1,
        account_id: account.id,
        account_email: account.email,
        status: 'queued',
        mailboxes_json: JSON.stringify(mailboxes),
        top,
        request_id: requestId || null,
      }))
    );

    this.logModel.create({
      job_id: jobId,
      request_id: requestId || null,
      level: 'info',
      event: 'job_created',
      status: 'queued',
      message: 'Bulk mail job created',
      meta_json: JSON.stringify({
        total_accounts: accounts.length,
        batch_size: batchSize,
        workers,
      }),
    });

    logger.info('bulk_mail_job_created', {
      job_id: jobId,
      request_id: requestId || undefined,
      status: 'queued',
      total_accounts: accounts.length,
      batch_size: batchSize,
      workers,
    });

    auditService.write({
      actor_type: 'api',
      actor_id: 'system',
      action: AuditActions.BULK_JOB_START,
      target_type: 'bulk_job',
      target_id: jobId,
      status: 'queued',
      request_id: requestId || undefined,
      job_id: jobId,
      extra: {
        total_accounts: accounts.length,
        batch_size: batchSize,
        workers,
        top,
        mailboxes,
        proxy_id: proxyId,
      },
    });

    bulkMailWorkerService.start(jobId, requestId);

    return this.jobModel.getByJobId(jobId)!;
  }

  getJob(jobId: string) {
    const job = this.jobModel.getByJobId(jobId);
    if (!job) return null;
    const effectiveStatus = this.getEffectiveStatus(job);

    const percent = job.total_accounts > 0
      ? Number(((job.processed_accounts / job.total_accounts) * 100).toFixed(2))
      : 0;

    return {
      ...job,
      status: effectiveStatus,
      can_cancel: this.isCancellableStatus(effectiveStatus),
      progress: {
        total_accounts: job.total_accounts,
        processed_accounts: job.processed_accounts,
        success_accounts: job.success_accounts,
        failed_accounts: job.failed_accounts,
        current_batch: job.current_batch,
        total_batches: job.total_batches,
        percent,
      },
      worker_running: bulkMailWorkerService.isRunning(jobId),
    };
  }

  getJobItems(jobId: string, page = 1, pageSize = 20) {
    const job = this.jobModel.getByJobId(jobId);
    if (!job) return null;
    return this.itemModel.getByJob(jobId, page, pageSize);
  }

  getJobLogs(jobId: string, page = 1, pageSize = 50) {
    const job = this.jobModel.getByJobId(jobId);
    if (!job) return null;
    return this.logModel.getByJob(jobId, page, pageSize);
  }

  cancelJob(jobId: string, requestId: string) {
    const job = this.jobModel.getByJobId(jobId);
    if (!job) return null;

    const effectiveStatus = this.getEffectiveStatus(job);
    if (!this.isCancellableStatus(effectiveStatus)) {
      return this.getJob(jobId);
    }

    const effectiveRequestId = requestId || job.request_id || null;
    const reason = 'Cancelled by user';
    const firstSignal = bulkMailWorkerService.requestCancel(jobId, effectiveRequestId || '');

    this.jobModel.cancel(jobId, reason);
    this.logModel.create({
      job_id: jobId,
      request_id: effectiveRequestId,
      level: 'warn',
      event: firstSignal ? 'job_cancel_requested' : 'job_cancel_already_requested',
      status: 'cancelled',
      message: reason,
    });

    auditService.write({
      actor_type: 'api',
      actor_id: 'system',
      action: AuditActions.BULK_JOB_CANCEL,
      target_type: 'bulk_job',
      target_id: jobId,
      status: 'cancelled',
      reason,
      request_id: effectiveRequestId || undefined,
      job_id: jobId,
      extra: {
        first_signal: firstSignal,
      },
    });

    logger.warn('bulk_mail_job_cancel_requested', {
      job_id: jobId,
      request_id: effectiveRequestId || undefined,
      status: 'cancelled',
      operation: 'bulk_job_cancel',
    });

    return this.getJob(jobId);
  }

  private generateJobId(): string {
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const rand = crypto.randomBytes(3).toString('hex');
    return `job_${ts}_${rand}`;
  }

  private parsePositiveInt(value: unknown, fallback: number): number {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
  }

  private normalizeMailboxes(input: unknown): Array<'INBOX' | 'Junk'> {
    const fallback: Array<'INBOX' | 'Junk'> = ['INBOX', 'Junk'];
    if (!Array.isArray(input) || input.length === 0) return fallback;

    const normalized = input
      .map((item) => String(item || '').trim())
      .map((item) => item.toUpperCase() === 'JUNK' ? 'Junk' : item.toUpperCase())
      .filter((item) => item === 'INBOX' || item === 'Junk') as Array<'INBOX' | 'Junk'>;

    if (normalized.length === 0) return fallback;

    return Array.from(new Set(normalized));
  }

  private resolveAccounts(accountIds?: number[]) {
    const allAccounts = this.accountModel.getAll();
    const activeAccounts = allAccounts.filter((account) => account.status !== 'inactive');

    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return activeAccounts;
    }

    const idSet = new Set(
      accountIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    );

    if (idSet.size === 0) {
      return [];
    }

    return activeAccounts.filter((account) => idSet.has(account.id));
  }

  private isCancellableStatus(status: BulkMailJobStatus): boolean {
    return status === 'queued' || status === 'running';
  }

  private getEffectiveStatus(job: BulkMailJobRecord): BulkMailJobStatus {
    if (job.error_code === BULK_JOB_CANCELLED_ERROR_CODE) {
      return 'cancelled';
    }
    return job.status;
  }
}
