import { Context, Next } from 'koa';
import logger from '../utils/logger';
import { getRequestId } from './requestId';

export async function loggerMiddleware(ctx: Context, next: Next) {
  const start = Date.now();

  try {
    await next();
  } finally {
    const durationMs = Date.now() - start;
    logger.info('request_completed', {
      request_id: getRequestId(ctx),
      method: ctx.method,
      path: ctx.path,
      status: ctx.status,
      duration_ms: durationMs,
      ip: ctx.ip,
      user_agent: ctx.get('user-agent') || undefined,
    });
  }
}
