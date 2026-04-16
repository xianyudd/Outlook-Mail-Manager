import { Context } from 'koa';
import { BulkMailJobService } from '../services/BulkMailJobService';
import { success, fail } from '../utils/response';
import { config } from '../config';
import { auditService, AuditActions } from '../services/AuditService';

const service = new BulkMailJobService();

export class BulkMailJobController {
  private getRequestId(ctx: Context): string {
    const stateRequestId = (ctx.state as Record<string, unknown>)?.request_id;
    const headerRequestId = ctx.get('X-Request-Id');
    return String(stateRequestId || headerRequestId || 'unknown');
  }

  private getActorId(ctx: Context): string {
    return String(ctx.get('X-Actor-Id') || ctx.ip || 'unknown');
  }

  async create(ctx: Context) {
    const requestId = this.getRequestId(ctx);
    const actorId = this.getActorId(ctx);

    if (config.featureFlags.READ_ONLY_MODE) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.READ_ONLY_REJECT,
        target_type: 'bulk_job',
        status: 'rejected',
        reason: 'read_only_mode',
        request_id: requestId,
        extra: {
          operation: 'bulk_job.create',
        },
      });
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    if (!config.featureFlags.BULK_PULL_ENABLED) {
      return fail(ctx, 'Bulk mail pull is disabled by configuration', 503);
    }

    const body = (ctx.request.body || {}) as Record<string, unknown>;
    try {
      const job = service.createAndStart({
        name: typeof body.name === 'string' ? body.name : undefined,
        account_ids: Array.isArray(body.account_ids) ? (body.account_ids as number[]) : undefined,
        mailboxes: Array.isArray(body.mailboxes) ? (body.mailboxes as string[]) : undefined,
        top: typeof body.top === 'number' ? body.top : Number(body.top),
        batch_size: typeof body.batch_size === 'number' ? body.batch_size : Number(body.batch_size),
        workers: typeof body.workers === 'number' ? body.workers : Number(body.workers),
        proxy_id: typeof body.proxy_id === 'number' ? body.proxy_id : Number(body.proxy_id),
      }, requestId);

      success(ctx, job);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      fail(ctx, message, 400);
    }
  }

  async detail(ctx: Context) {
    const { jobId } = ctx.params;
    const job = service.getJob(jobId);
    if (!job) {
      return fail(ctx, 'Job not found', 404);
    }
    success(ctx, job);
  }

  async items(ctx: Context) {
    const { jobId } = ctx.params;
    const page = Number((ctx.query.page as string) || '1');
    const pageSize = Number((ctx.query.pageSize as string) || '20');

    const result = service.getJobItems(jobId, page, pageSize);
    if (!result) {
      return fail(ctx, 'Job not found', 404);
    }

    success(ctx, result);
  }

  async logs(ctx: Context) {
    const { jobId } = ctx.params;
    const page = Number((ctx.query.page as string) || '1');
    const pageSize = Number((ctx.query.pageSize as string) || '50');

    const result = service.getJobLogs(jobId, page, pageSize);
    if (!result) {
      return fail(ctx, 'Job not found', 404);
    }

    success(ctx, result);
  }

  async cancel(ctx: Context) {
    const requestId = this.getRequestId(ctx);
    const actorId = this.getActorId(ctx);
    const { jobId } = ctx.params;

    if (config.featureFlags.READ_ONLY_MODE) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.READ_ONLY_REJECT,
        target_type: 'bulk_job',
        target_id: jobId || undefined,
        status: 'rejected',
        reason: 'read_only_mode',
        request_id: requestId,
        extra: {
          operation: 'bulk_job.cancel',
        },
      });
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    const job = service.cancelJob(jobId, requestId);
    if (!job) {
      return fail(ctx, 'Job not found', 404);
    }

    success(ctx, job);
  }
}
