import { Context, Next } from 'koa';
import crypto from 'crypto';

const REQUEST_ID_HEADER = 'x-request-id';

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

export function getRequestId(ctx: Context): string {
  const state = ctx.state as Record<string, unknown>;
  const value = state.request_id;
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return '';
}

export async function requestIdMiddleware(ctx: Context, next: Next) {
  const incoming = ctx.get(REQUEST_ID_HEADER).trim();
  const requestId = incoming && incoming.length <= 128 ? incoming : createRequestId();

  (ctx.state as Record<string, unknown>).request_id = requestId;
  ctx.set('X-Request-Id', requestId);

  await next();
}
