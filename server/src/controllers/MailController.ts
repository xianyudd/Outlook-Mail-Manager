import { Context } from 'koa';
import { MailService, MailServiceLogContext } from '../services/MailService';
import { MailCacheModel } from '../models/MailCache';
import { success, fail } from '../utils/response';
import logger from '../utils/logger';
import { config } from '../config';

const mailService = new MailService();
const cacheModel = new MailCacheModel();

export class MailController {
  private getRequestId(ctx: Context): string {
    const stateRequestId = (ctx.state as any)?.request_id;
    const headerRequestId = ctx.get('X-Request-Id');
    return String(stateRequestId || headerRequestId || 'unknown');
  }

  private buildLogContext(
    ctx: Context,
    accountId: unknown,
    mailbox: string,
    proxyId?: unknown
  ): MailServiceLogContext {
    const accountIdNum = Number(accountId);
    const proxyIdNum = Number(proxyId);

    return {
      request_id: this.getRequestId(ctx),
      account_id: Number.isFinite(accountIdNum) ? accountIdNum : undefined,
      mailbox,
      proxy_id: Number.isFinite(proxyIdNum) ? proxyIdNum : undefined,
    };
  }

  async fetch(ctx: Context) {
    const startedAt = Date.now();
    if (!config.featureFlags.MAIL_FETCH_ENABLED) {
      return fail(ctx, 'Mail fetch is disabled by configuration', 503);
    }

    const { account_id, mailbox = 'INBOX', proxy_id, top = 50 } = ctx.request.body as any;
    const logContext = this.buildLogContext(ctx, account_id, mailbox, proxy_id);

    logger.info({
      event: 'mail_controller_fetch',
      status: 'started',
      ...logContext,
      top: Number(top),
    });

    if (!account_id) {
      logger.warn({
        event: 'mail_controller_fetch',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: 'account_id is required',
      });
      return fail(ctx, 'account_id is required', 400);
    }

    const topNum = Number(top);
    if (!Number.isFinite(topNum) || topNum <= 0) {
      logger.warn({
        event: 'mail_controller_fetch',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: 'top must be a positive number',
      });
      return fail(ctx, 'top must be a positive number', 400);
    }

    try {
      const result = await mailService.fetchMails(account_id, mailbox, proxy_id, Math.floor(topNum), logContext);
      logger.info({
        event: 'mail_controller_fetch',
        status: 'succeeded',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        protocol: result.protocol,
        cached: result.cached,
        total: result.total,
      });
      success(ctx, result);
    } catch (err: any) {
      logger.error({
        event: 'mail_controller_fetch',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });
      fail(ctx, `Failed to fetch mails: ${err.message}`);
    }
  }

  async fetchNew(ctx: Context) {
    const startedAt = Date.now();
    if (!config.featureFlags.MAIL_FETCH_ENABLED) {
      return fail(ctx, 'Mail fetch is disabled by configuration', 503);
    }

    const { account_id, mailbox = 'INBOX', proxy_id } = ctx.request.body as any;
    const logContext = this.buildLogContext(ctx, account_id, mailbox, proxy_id);

    logger.info({
      event: 'mail_controller_fetch_new',
      status: 'started',
      ...logContext,
    });

    if (!account_id) {
      logger.warn({
        event: 'mail_controller_fetch_new',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: 'account_id is required',
      });
      return fail(ctx, 'account_id is required', 400);
    }

    try {
      const result = await mailService.fetchMails(account_id, mailbox, proxy_id, 1, logContext);
      logger.info({
        event: 'mail_controller_fetch_new',
        status: 'succeeded',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        protocol: result.protocol,
        cached: result.cached,
        total: result.total,
      });
      success(ctx, result.mails[0] || null);
    } catch (err: any) {
      logger.error({
        event: 'mail_controller_fetch_new',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });
      fail(ctx, `Failed to fetch new mail: ${err.message}`);
    }
  }

  async clear(ctx: Context) {
    const startedAt = Date.now();
    if (config.featureFlags.READ_ONLY_MODE) {
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    if (!config.featureFlags.MAIL_CLEAR_REMOTE_ENABLED) {
      return fail(ctx, 'Remote mailbox clearing is disabled by configuration', 403);
    }

    const { account_id, mailbox = 'INBOX', proxy_id } = ctx.request.body as any;
    const logContext = this.buildLogContext(ctx, account_id, mailbox, proxy_id);

    logger.info({
      event: 'mail_controller_clear',
      status: 'started',
      ...logContext,
    });

    if (!account_id) {
      logger.warn({
        event: 'mail_controller_clear',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: 'account_id is required',
      });
      return fail(ctx, 'account_id is required', 400);
    }

    try {
      await mailService.clearMailbox(account_id, mailbox, proxy_id, logContext);
      cacheModel.clearByAccount(account_id, mailbox);
      logger.info({
        event: 'mail_controller_clear',
        status: 'succeeded',
        ...logContext,
        duration_ms: Date.now() - startedAt,
      });
      success(ctx, { message: '邮件正在清空中...' });
    } catch (err: any) {
      logger.error({
        event: 'mail_controller_clear',
        status: 'failed',
        ...logContext,
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });
      fail(ctx, `Failed to clear mailbox: ${err.message}`);
    }
  }

  async cached(ctx: Context) {
    const { account_id, mailbox = 'INBOX', page = '1', pageSize = '50' } = ctx.query as Record<string, string>;
    if (!account_id) return fail(ctx, 'account_id is required', 400);
    const data = cacheModel.getByAccount(parseInt(account_id), mailbox, parseInt(page), parseInt(pageSize));
    success(ctx, data);
  }
}
