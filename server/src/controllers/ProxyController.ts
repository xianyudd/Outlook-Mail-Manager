import { Context } from 'koa';
import { ProxyModel } from '../models/Proxy';
import { ProxyService } from '../services/ProxyService';
import { success, fail } from '../utils/response';
import { auditService, AuditActions } from '../services/AuditService';
import { config } from '../config';

const model = new ProxyModel();
const proxyService = new ProxyService();

export class ProxyController {
  private getRequestId(ctx: Context): string {
    const stateRequestId = (ctx.state as Record<string, unknown>)?.request_id;
    const headerRequestId = ctx.get('X-Request-Id');
    return String(stateRequestId || headerRequestId || 'unknown');
  }

  private getActorId(ctx: Context): string {
    return String(ctx.get('X-Actor-Id') || ctx.ip || 'unknown');
  }

  private buildSafeProxyExtra(data: Record<string, unknown>) {
    return {
      name: typeof data.name === 'string' ? data.name : undefined,
      type: typeof data.type === 'string' ? data.type : undefined,
      host: typeof data.host === 'string' ? data.host : undefined,
      port: Number.isFinite(Number(data.port)) ? Number(data.port) : undefined,
      is_default: Boolean(data.is_default),
      has_username: Boolean(data.username),
      has_password: Boolean(data.password),
    };
  }

  async list(ctx: Context) {
    success(ctx, model.list());
  }

  async create(ctx: Context) {
    const body = (ctx.request.body || {}) as Record<string, unknown>;
    const requestId = this.getRequestId(ctx);
    const actorId = this.getActorId(ctx);

    if (config.featureFlags.READ_ONLY_MODE) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.READ_ONLY_REJECT,
        target_type: 'proxy',
        status: 'rejected',
        reason: 'read_only_mode',
        request_id: requestId,
        extra: {
          operation: 'proxy.create',
        },
      });
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    if (!body.type || !body.host || !body.port) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.PROXY_CREATE,
        target_type: 'proxy',
        status: 'failed',
        reason: 'type, host, port are required',
        request_id: requestId,
        extra: this.buildSafeProxyExtra(body),
      });
      return fail(ctx, 'type, host, port are required', 400);
    }

    const proxy = model.create(body);

    auditService.write({
      actor_type: 'api',
      actor_id: actorId,
      action: AuditActions.PROXY_CREATE,
      target_type: 'proxy',
      target_id: String(proxy.id),
      status: 'succeeded',
      request_id: requestId,
      extra: this.buildSafeProxyExtra(body),
    });

    success(ctx, proxy);
  }

  async update(ctx: Context) {
    const id = parseInt(ctx.params.id, 10);
    const body = (ctx.request.body || {}) as Record<string, unknown>;
    const requestId = this.getRequestId(ctx);
    const actorId = this.getActorId(ctx);

    if (config.featureFlags.READ_ONLY_MODE) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.READ_ONLY_REJECT,
        target_type: 'proxy',
        target_id: String(id),
        status: 'rejected',
        reason: 'read_only_mode',
        request_id: requestId,
        extra: {
          operation: 'proxy.update',
        },
      });
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    const proxy = model.update(id, body);
    if (!proxy) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.PROXY_UPDATE,
        target_type: 'proxy',
        target_id: String(id),
        status: 'failed',
        reason: 'proxy_not_found',
        request_id: requestId,
        extra: this.buildSafeProxyExtra(body),
      });
      return fail(ctx, 'Proxy not found', 404);
    }

    auditService.write({
      actor_type: 'api',
      actor_id: actorId,
      action: AuditActions.PROXY_UPDATE,
      target_type: 'proxy',
      target_id: String(id),
      status: 'succeeded',
      request_id: requestId,
      extra: this.buildSafeProxyExtra(body),
    });

    success(ctx, proxy);
  }

  async delete(ctx: Context) {
    const id = parseInt(ctx.params.id, 10);
    const requestId = this.getRequestId(ctx);
    const actorId = this.getActorId(ctx);

    if (config.featureFlags.READ_ONLY_MODE) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.READ_ONLY_REJECT,
        target_type: 'proxy',
        target_id: String(id),
        status: 'rejected',
        reason: 'read_only_mode',
        request_id: requestId,
        extra: {
          operation: 'proxy.delete',
        },
      });
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    if (!model.delete(id)) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.PROXY_DELETE,
        target_type: 'proxy',
        target_id: String(id),
        status: 'failed',
        reason: 'proxy_not_found',
        request_id: requestId,
      });
      return fail(ctx, 'Proxy not found', 404);
    }

    auditService.write({
      actor_type: 'api',
      actor_id: actorId,
      action: AuditActions.PROXY_DELETE,
      target_type: 'proxy',
      target_id: String(id),
      status: 'succeeded',
      request_id: requestId,
    });

    success(ctx, { deleted: true });
  }

  async test(ctx: Context) {
    const id = parseInt(ctx.params.id, 10);
    const proxy = model.getById(id);
    if (!proxy) return fail(ctx, 'Proxy not found', 404);
    try {
      const result = await proxyService.testProxy(proxy);
      model.updateTestResult(id, result.ip, result.status);
      success(ctx, result);
    } catch (err: any) {
      model.updateTestResult(id, '', 'failed');
      fail(ctx, `Proxy test failed: ${err.message}`);
    }
  }

  async setDefault(ctx: Context) {
    const id = parseInt(ctx.params.id, 10);
    const requestId = this.getRequestId(ctx);
    const actorId = this.getActorId(ctx);

    if (config.featureFlags.READ_ONLY_MODE) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.READ_ONLY_REJECT,
        target_type: 'proxy',
        target_id: String(id),
        status: 'rejected',
        reason: 'read_only_mode',
        request_id: requestId,
        extra: {
          operation: 'proxy.set_default',
        },
      });
      return fail(ctx, 'Service is in read-only mode', 403);
    }

    const proxy = model.setDefault(id);
    if (!proxy) {
      auditService.write({
        actor_type: 'api',
        actor_id: actorId,
        action: AuditActions.PROXY_SET_DEFAULT,
        target_type: 'proxy',
        target_id: String(id),
        status: 'failed',
        reason: 'proxy_not_found',
        request_id: requestId,
      });
      return fail(ctx, 'Proxy not found', 404);
    }

    auditService.write({
      actor_type: 'api',
      actor_id: actorId,
      action: AuditActions.PROXY_SET_DEFAULT,
      target_type: 'proxy',
      target_id: String(id),
      status: 'succeeded',
      request_id: requestId,
      extra: {
        is_default: true,
      },
    });

    success(ctx, proxy);
  }
}
