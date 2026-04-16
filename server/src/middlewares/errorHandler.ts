import { Context, Next } from 'koa';
import logger from '../utils/logger';
import { getRequestId } from './requestId';

function extractRequestBodyKeys(ctx: Context): string[] {
  const requestBody = (ctx.request as { body?: unknown }).body;
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    return [];
  }

  return Object.keys(requestBody as Record<string, unknown>).slice(0, 50);
}

export async function errorHandler(ctx: Context, next: Next) {
  try {
    await next();
  } catch (error: unknown) {
    const err = error as {
      status?: number;
      message?: string;
      stack?: string;
      code?: string;
      name?: string;
    };

    const status = typeof err.status === 'number' ? err.status : 500;
    const requestId = getRequestId(ctx);
    const responseMessage = status >= 500 ? 'Internal Server Error' : err.message || 'Request Failed';

    logger.error('request_failed', {
      request_id: requestId,
      method: ctx.method,
      path: ctx.path,
      status,
      error_name: err.name,
      error_code: err.code,
      error_message: err.message,
      stack: err.stack,
      request_content_type: ctx.get('content-type') || undefined,
      request_body_keys: extractRequestBodyKeys(ctx),
    });

    ctx.status = status;
    ctx.body = {
      code: status,
      data: null,
      message: responseMessage,
      request_id: requestId,
    };
  }
}
