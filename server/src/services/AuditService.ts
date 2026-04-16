import { AuditEventModel } from '../models/AuditEvent';
import { sanitizeForLog } from '../utils/logSanitizer';
import logger from '../utils/logger';

export const AuditActions = {
  MAIL_FETCH_MANUAL: 'mail.fetch.manual',
  MAIL_CLEAR: 'mail.clear',
  PROXY_CREATE: 'proxy.create',
  PROXY_UPDATE: 'proxy.update',
  PROXY_DELETE: 'proxy.delete',
  PROXY_SET_DEFAULT: 'proxy.set_default',
  READ_ONLY_REJECT: 'guard.read_only.reject',
  BULK_JOB_START: 'bulk.job.start',
  BULK_JOB_CANCEL: 'bulk.job.cancel',
  BULK_JOB_COMPLETE: 'bulk.job.complete',
  BULK_JOB_FAIL: 'bulk.job.fail',
} as const;

interface AuditWriteInput {
  actor_type: string;
  actor_id?: string | null;
  action: string;
  target_type?: string | null;
  target_id?: string | null;
  mailbox?: string | null;
  status: string;
  reason?: string | null;
  request_id?: string | null;
  job_id?: string | null;
  extra?: Record<string, unknown> | null;
}

interface BulkJobLogAuditInput {
  job_id: string;
  request_id?: string | null;
  account_email?: string | null;
  event: string;
  status?: string | null;
  error_code?: string | null;
  message?: string | null;
  meta_json?: string | null;
}

const FORBIDDEN_EXTRA_KEYS = new Set([
  'text_content',
  'html_content',
  'mail_body',
  'body',
  'raw',
  'raw_content',
  'attachments',
  'attachment',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class AuditService {
  private model = new AuditEventModel();

  write(input: AuditWriteInput): void {
    try {
      const extraJson = JSON.stringify(this.sanitizeExtra(input.extra));

      this.model.create({
        actor_type: input.actor_type,
        actor_id: input.actor_id ?? null,
        action: input.action,
        target_type: input.target_type ?? null,
        target_id: input.target_id ?? null,
        mailbox: input.mailbox ?? null,
        status: input.status,
        reason: input.reason ?? null,
        request_id: input.request_id ?? null,
        job_id: input.job_id ?? null,
        extra_json: extraJson,
      });
    } catch (error: unknown) {
      logger.error({
        event: 'audit_event_write_failed',
        status: 'failed',
        action: input.action,
        request_id: input.request_id ?? 'unknown',
        job_id: input.job_id ?? undefined,
        error_message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  writeFromBulkJobLog(input: BulkJobLogAuditInput): void {
    const mapped = this.mapBulkEventToAction(input.event, input.status);
    if (!mapped) return;

    this.write({
      actor_type: 'system',
      action: mapped.action,
      target_type: 'bulk_job',
      target_id: input.job_id,
      status: mapped.status,
      reason: input.error_code || input.message || undefined,
      request_id: input.request_id ?? undefined,
      job_id: input.job_id,
      extra: {
        source_event: input.event,
        account_email: input.account_email ?? undefined,
        meta: this.safeParseMeta(input.meta_json),
      },
    });
  }

  private mapBulkEventToAction(
    event: string,
    status?: string | null,
  ): { action: string; status: string } | null {
    switch (event) {
      case 'job_completed':
        return { action: AuditActions.BULK_JOB_COMPLETE, status: status || 'completed' };
      case 'job_failed':
        return { action: AuditActions.BULK_JOB_FAIL, status: 'failed' };
      default:
        return null;
    }
  }

  private safeParseMeta(raw?: string | null): Record<string, unknown> {
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) return parsed;
      return { value: parsed };
    } catch {
      return {};
    }
  }

  private sanitizeExtra(extra?: Record<string, unknown> | null): Record<string, unknown> {
    const sanitized = sanitizeForLog(extra || {});
    const compacted = this.compactValue(sanitized, 0);
    return isRecord(compacted) ? compacted : {};
  }

  private compactValue(value: unknown, depth: number): unknown {
    if (depth > 6) {
      return '[MaxDepthExceeded]';
    }

    if (typeof value === 'string') {
      if (value.length > 2000) {
        return `${value.slice(0, 2000)}...[TRUNCATED]`;
      }
      return value;
    }

    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => this.compactValue(item, depth + 1));
    }

    if (isRecord(value)) {
      const output: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_EXTRA_KEYS.has(key.toLowerCase())) {
          output[key] = '[OMITTED]';
          continue;
        }
        output[key] = this.compactValue(child, depth + 1);
      }
      return output;
    }

    return value;
  }
}

export const auditService = new AuditService();
