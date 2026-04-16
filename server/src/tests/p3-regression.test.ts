import test from 'node:test';
import assert from 'node:assert/strict';
import { BulkMailWorkerService } from '../services/BulkMailWorkerService';
import { GraphApiService } from '../services/GraphApiService';
import { BulkMailJobController } from '../controllers/BulkMailJobController';
import { BulkMailJobService } from '../services/BulkMailJobService';
import { AuditActions, AuditService, auditService } from '../services/AuditService';
import { MailController } from '../controllers/MailController';
import { ProxyController } from '../controllers/ProxyController';
import { config } from '../config';

type AnyRecord = Record<string, any>;

function createFakeResponse(status: number, retryAfter?: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'retry-after') {
          return retryAfter ?? null;
        }
        return null;
      },
    },
  };
}

test('bulk worker should propagate request_id/job_id context into MailService', async () => {
  const worker = new BulkMailWorkerService() as any;
  const capturedContexts: AnyRecord[] = [];

  worker.shouldStopJob = () => false;
  worker.mailService = {
    fetchMails: async (
      _accountId: number,
      _mailbox: string,
      _proxyId: number | undefined,
      _top: number,
      logContext: AnyRecord,
    ) => {
      capturedContexts.push(logContext);
      return { mails: [], total: 0, protocol: 'graph', cached: false };
    },
  };
  worker.itemModel = {
    markRunning: () => undefined,
    markSuccess: () => undefined,
    markFailed: () => undefined,
  };
  worker.jobModel = {
    incrementProgress: () => undefined,
  };
  worker.logModel = {
    create: () => undefined,
  };

  const job = {
    id: 1,
    job_id: 'job_test_001',
    name: 'job',
    status: 'running',
    mailboxes_json: '["INBOX","Junk"]',
    top: 10,
    batch_size: 10,
    workers: 1,
    proxy_id: 3,
    total_accounts: 1,
    processed_accounts: 0,
    success_accounts: 0,
    failed_accounts: 0,
    current_batch: 1,
    total_batches: 1,
    inbox_total: 0,
    junk_total: 0,
    mail_total: 0,
    request_id: 'req-abc-123',
    error_code: null,
    error_message: null,
    created_at: '',
    started_at: null,
    finished_at: null,
    updated_at: '',
  };

  const item = {
    id: 11,
    job_id: 'job_test_001',
    batch_no: 1,
    account_id: 99,
    account_email: 'tester@example.com',
    status: 'queued',
    retry_count: 0,
    mailboxes_json: '["INBOX","Junk"]',
    top: 10,
    inbox_count: 0,
    junk_count: 0,
    fetched_total: 0,
    request_id: null,
    error_code: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    created_at: '',
    updated_at: '',
  };

  await worker.processItem(job, item, 'req-abc-123');

  assert.equal(capturedContexts.length, 2);
  const first = capturedContexts[0];
  assert.equal(first.request_id, 'req-abc-123');
  assert.equal(first.job_id, 'job_test_001');
  assert.equal(first.account_id, 99);
  assert.equal(first.account_email, 'tester@example.com');
  assert.equal(first.provider, 'microsoft');
  assert.equal(first.operation, 'bulk_fetch_mails');
  assert.equal(first.proxy_id, 3);
  assert.equal(first.mailbox, 'INBOX');
  assert.equal(capturedContexts[1].mailbox, 'Junk');
});

test('graph request retry should retry on retryable status and keep client-request-id format', async () => {
  const service = new GraphApiService() as any;

  const generatedClientRequestId = service.buildClientRequestId('req-main-1');
  assert.match(generatedClientRequestId, /^req-main-1-/);

  let calls = 0;
  service.executeGraphRequest = async () => {
    calls += 1;
    if (calls === 1) return createFakeResponse(429, '0');
    if (calls === 2) return createFakeResponse(503);
    return createFakeResponse(200);
  };
  service.sleep = async () => undefined;

  const result = await service.requestWithRetry({
    url: 'https://graph.microsoft.com/v1.0/me/messages',
    method: 'GET',
    accessToken: 'token',
    baseLog: { request_id: 'req-main-1' },
    clientRequestId: generatedClientRequestId,
  });

  assert.equal(calls, 3);
  assert.equal(result.attempt, 3);
  assert.equal(result.response.status, 200);
});

test('bulk job logs/cancel API handlers should return expected payloads', async () => {
  const originalGetJobLogs = BulkMailJobService.prototype.getJobLogs;
  const originalCancelJob = BulkMailJobService.prototype.cancelJob;
  const originalReadOnly = config.featureFlags.READ_ONLY_MODE;

  BulkMailJobService.prototype.getJobLogs = function mockedGetLogs() {
    return {
      list: [{ id: 1, event: 'job_started' }],
      total: 1,
      page: 1,
      pageSize: 50,
    } as any;
  };

  BulkMailJobService.prototype.cancelJob = function mockedCancel() {
    return {
      job_id: 'job_test_001',
      status: 'cancelled',
      can_cancel: false,
    } as any;
  };

  try {
    const controller = new BulkMailJobController();

    config.featureFlags.READ_ONLY_MODE = false;
    const logsCtx: AnyRecord = {
      params: { jobId: 'job_test_001' },
      query: { page: '1', pageSize: '50' },
    };
    await controller.logs(logsCtx as any);
    assert.equal(logsCtx.body.code, 200);
    assert.equal(logsCtx.body.data.total, 1);

    const cancelCtx: AnyRecord = {
      params: { jobId: 'job_test_001' },
      state: { request_id: 'req-cancel-1' },
      request: { body: {} },
      get: (_name: string) => '',
      ip: '127.0.0.1',
    };
    await controller.cancel(cancelCtx as any);
    assert.equal(cancelCtx.body.code, 200);
    assert.equal(cancelCtx.body.data.status, 'cancelled');

    config.featureFlags.READ_ONLY_MODE = true;
    const readOnlyCancelCtx: AnyRecord = {
      params: { jobId: 'job_test_001' },
      state: { request_id: 'req-cancel-2' },
      request: { body: {} },
      get: (_name: string) => '',
      ip: '127.0.0.1',
    };
    await controller.cancel(readOnlyCancelCtx as any);
    assert.equal(readOnlyCancelCtx.body.code, 403);
  } finally {
    BulkMailJobService.prototype.getJobLogs = originalGetJobLogs;
    BulkMailJobService.prototype.cancelJob = originalCancelJob;
    config.featureFlags.READ_ONLY_MODE = originalReadOnly;
  }
});

test('audit service should sanitize sensitive values before writing', () => {
  const service = new AuditService() as any;
  let captured: AnyRecord | null = null;

  service.model = {
    create(input: AnyRecord) {
      captured = input;
      return { id: 1, ...input };
    },
  };

  const sensitiveField = 'password';
  const sensitiveValue = 'fixture-nonsecret-value';

  service.write({
    actor_type: 'api',
    actor_id: 'tester',
    action: AuditActions.MAIL_FETCH_MANUAL,
    target_type: 'account',
    target_id: '1',
    mailbox: 'INBOX',
    status: 'succeeded',
    request_id: 'req-audit-1',
    extra: {
      [sensitiveField]: sensitiveValue,
      html_content: '<html>top-secret</html>',
      nested: {
        authorization: 'Bearer token-123',
      },
    },
  });

  assert.ok(captured);
  const capturedRecord = captured as AnyRecord;
  const extra = JSON.parse(String(capturedRecord.extra_json));
  assert.equal(extra.password, '[REDACTED]');
  assert.equal(extra.html_content, '[OMITTED]');
  assert.equal(extra.nested.authorization, '[REDACTED]');
});

test('read-only mailbox clear rejection should emit audit event', async () => {
  const controller = new MailController();
  const originalReadOnly = config.featureFlags.READ_ONLY_MODE;
  const originalWrite = auditService.write;

  let capturedAudit: AnyRecord | null = null;
  (auditService as any).write = (input: AnyRecord) => {
    capturedAudit = input;
  };

  config.featureFlags.READ_ONLY_MODE = true;

  try {
    const ctx: AnyRecord = {
      state: { request_id: 'req-readonly-1' },
      request: {
        body: {
          account_id: 123,
          mailbox: 'INBOX',
          proxy_id: 8,
        },
      },
      get: (_name: string) => '',
      ip: '127.0.0.1',
    };

    await controller.clear(ctx as any);

    assert.equal(ctx.body.code, 403);
    assert.ok(capturedAudit, 'read-only rejection should be audited');
    const auditRecord = capturedAudit as AnyRecord;
    assert.equal(auditRecord.action, AuditActions.READ_ONLY_REJECT);
    assert.equal(auditRecord.request_id, 'req-readonly-1');
    assert.equal(auditRecord.status, 'rejected');
  } finally {
    config.featureFlags.READ_ONLY_MODE = originalReadOnly;
    (auditService as any).write = originalWrite;
  }
});

test('read-only bulk create rejection should emit audit event', async () => {
  const controller = new BulkMailJobController();
  const originalReadOnly = config.featureFlags.READ_ONLY_MODE;
  const originalWrite = auditService.write;

  let capturedAudit: AnyRecord | null = null;
  (auditService as any).write = (input: AnyRecord) => {
    capturedAudit = input;
  };

  config.featureFlags.READ_ONLY_MODE = true;

  try {
    const ctx: AnyRecord = {
      state: { request_id: 'req-bulk-readonly-1' },
      request: {
        body: {},
      },
      get: (_name: string) => '',
      ip: '127.0.0.1',
    };

    await controller.create(ctx as any);

    assert.equal(ctx.body.code, 403);
    assert.ok(capturedAudit, 'read-only bulk create rejection should be audited');
    const auditRecord = capturedAudit as AnyRecord;
    assert.equal(auditRecord.action, AuditActions.READ_ONLY_REJECT);
    assert.equal(auditRecord.request_id, 'req-bulk-readonly-1');
    assert.equal(auditRecord.status, 'rejected');
    assert.equal(auditRecord.extra.operation, 'bulk_job.create');
  } finally {
    config.featureFlags.READ_ONLY_MODE = originalReadOnly;
    (auditService as any).write = originalWrite;
  }
});

test('read-only proxy create rejection should emit audit event', async () => {
  const controller = new ProxyController();
  const originalReadOnly = config.featureFlags.READ_ONLY_MODE;
  const originalWrite = auditService.write;

  let capturedAudit: AnyRecord | null = null;
  (auditService as any).write = (input: AnyRecord) => {
    capturedAudit = input;
  };

  config.featureFlags.READ_ONLY_MODE = true;

  try {
    const ctx: AnyRecord = {
      request: {
        body: {
          type: 'http',
          host: '127.0.0.1',
          port: 8080,
        },
      },
      get: (_name: string) => '',
      ip: '127.0.0.1',
      state: { request_id: 'req-proxy-readonly-1' },
    };

    await controller.create(ctx as any);

    assert.equal(ctx.body.code, 403);
    assert.ok(capturedAudit, 'read-only proxy create rejection should be audited');
    const auditRecord = capturedAudit as AnyRecord;
    assert.equal(auditRecord.action, AuditActions.READ_ONLY_REJECT);
    assert.equal(auditRecord.request_id, 'req-proxy-readonly-1');
    assert.equal(auditRecord.status, 'rejected');
    assert.equal(auditRecord.extra.operation, 'proxy.create');
  } finally {
    config.featureFlags.READ_ONLY_MODE = originalReadOnly;
    (auditService as any).write = originalWrite;
  }
});

test('graph request retry should cap retry-after delay', async () => {
  const service = new GraphApiService() as any;
  const slept: number[] = [];

  let calls = 0;
  service.executeGraphRequest = async () => {
    calls += 1;
    if (calls === 1) return createFakeResponse(429, '100');
    return createFakeResponse(200);
  };
  service.sleep = async (ms: number) => {
    slept.push(ms);
  };

  await service.requestWithRetry({
    url: 'https://graph.microsoft.com/v1.0/me/messages',
    method: 'GET',
    accessToken: 'token',
    baseLog: { request_id: 'req-delay-cap-1' },
    clientRequestId: service.buildClientRequestId('req-delay-cap-1'),
  });

  assert.equal(calls, 2);
  assert.equal(slept.length, 1);
  assert.equal(slept[0], 15000);
});
