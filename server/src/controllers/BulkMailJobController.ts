import { Context } from 'koa';
import { BulkMailJobService } from '../services/BulkMailJobService';
import { success, fail } from '../utils/response';
import { config } from '../config';

const service = new BulkMailJobService();

export class BulkMailJobController {
  async create(ctx: Context) {
    if (config.featureFlags.READ_ONLY_MODE) {
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    if (!config.featureFlags.BULK_PULL_ENABLED) {
      return fail(ctx, 'Bulk mail pull is disabled by configuration', 503);
    }

    const body = (ctx.request.body || {}) as Record<string, unknown>;
    const requestId = typeof (ctx.state as Record<string, unknown>).request_id === 'string'
      ? (ctx.state as Record<string, string>).request_id
      : '';

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
}
