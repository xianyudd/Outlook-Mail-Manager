import crypto from 'crypto';
import { ProxyService } from './ProxyService';
import { MailMessage } from '../types';
import logger from '../utils/logger';

const proxyService = new ProxyService();

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 5000;
const MAX_SERVER_RETRY_AFTER_MS = 15000;

interface GraphLogContext {
  request_id?: string;
  job_id?: string;
  account_id?: number;
  account_email?: string;
  mailbox?: string;
  provider?: string;
  operation?: string;
  proxy_id?: number;
  protocol?: 'graph' | 'imap';
}

interface GraphRequestResult {
  response: any;
  attempt: number;
  retry_after?: number;
}

type GraphRequestMethod = 'GET' | 'DELETE';

export class GraphApiService {
  async fetchMails(
    accessToken: string,
    mailbox: string,
    top = 50,
    proxyId?: number,
    logContext?: GraphLogContext
  ): Promise<Partial<MailMessage>[]> {
    const startedAt = Date.now();
    const folder = mailbox === 'Junk' ? 'junkemail' : 'inbox';
    const clientRequestId = this.buildClientRequestId(logContext?.request_id);
    const { agent, dispatcher, type } = proxyService.getAgent(proxyId, {
      request_id: logContext?.request_id,
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      mailbox,
      provider: 'graph',
      operation: 'graph_fetch_mails',
      proxy_id: proxyId,
    });

    const baseLog = {
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox,
      folder,
      top,
      proxy_id: proxyId,
      proxy_type: type || 'none',
      protocol: 'graph',
      provider: logContext?.provider || 'graph',
      operation: logContext?.operation || 'fetch_mails',
      client_request_id: clientRequestId,
    };

    logger.info({
      event: 'graph_fetch_mails',
      status: 'started',
      ...baseLog,
    });

    const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${top}`;

    let requestResult: GraphRequestResult;
    try {
      requestResult = await this.requestWithRetry({
        url,
        method: 'GET',
        accessToken,
        agent,
        dispatcher,
        type,
        baseLog,
        clientRequestId,
      });
    } catch (err: any) {
      logger.error({
        event: 'graph_fetch_mails',
        status: 'failed',
        ...baseLog,
        attempt: err?.attempt || 1,
        duration_ms: Date.now() - startedAt,
        error_code: this.getErrorCode(err),
        error_message: err?.message || 'Graph request failed',
      });
      throw err;
    }

    const { response, attempt, retry_after } = requestResult;
    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({
        event: 'graph_fetch_mails',
        status: 'failed',
        ...baseLog,
        status_code: response.status,
        retry_after: retry_after ?? null,
        attempt,
        duration_ms: Date.now() - startedAt,
        error_message: errorText.slice(0, 300),
      });
      throw new Error(`Graph API fetch failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const emails = (data.value || []).map((item: any) => ({
      mail_id: item.id,
      sender: item.from?.emailAddress?.address || '',
      sender_name: item.from?.emailAddress?.name || '',
      subject: item.subject || '',
      text_content: item.bodyPreview || '',
      html_content: item.body?.content || '',
      mail_date: item.createdDateTime || '',
    }));

    logger.info({
      event: 'graph_fetch_mails',
      status: 'succeeded',
      ...baseLog,
      mail_count: emails.length,
      attempt,
      duration_ms: Date.now() - startedAt,
    });
    return emails;
  }

  async deleteMail(accessToken: string, mailId: string, proxyId?: number, logContext?: GraphLogContext): Promise<void> {
    const startedAt = Date.now();
    const clientRequestId = this.buildClientRequestId(logContext?.request_id);
    const { agent, dispatcher, type } = proxyService.getAgent(proxyId, {
      request_id: logContext?.request_id,
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      mailbox: logContext?.mailbox,
      provider: 'graph',
      operation: 'graph_delete_mail',
      proxy_id: proxyId,
    });
    const url = `https://graph.microsoft.com/v1.0/me/messages/${mailId}`;
    const baseLog = {
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox: logContext?.mailbox,
      proxy_id: proxyId,
      proxy_type: type || 'none',
      protocol: 'graph',
      provider: logContext?.provider || 'graph',
      operation: logContext?.operation || 'delete_mail',
      mail_id: mailId,
      client_request_id: clientRequestId,
    };

    try {
      const { response, attempt, retry_after } = await this.requestWithRetry({
        url,
        method: 'DELETE',
        accessToken,
        agent,
        dispatcher,
        type,
        baseLog,
        clientRequestId,
      });

      if (response && !response.ok) {
        const errorText = await response.text();
        logger.warn({
          event: 'graph_delete_mail',
          status: 'failed',
          ...baseLog,
          status_code: response.status,
          retry_after: retry_after ?? null,
          attempt,
          duration_ms: Date.now() - startedAt,
          error_message: errorText.slice(0, 300),
        });
        throw new Error(`Graph delete failed: ${response.status} - ${errorText}`);
      }

      logger.info({
        event: 'graph_delete_mail',
        status: 'succeeded',
        ...baseLog,
        attempt,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err: any) {
      logger.error({
        event: 'graph_delete_mail',
        status: 'failed',
        ...baseLog,
        attempt: err?.attempt || 1,
        duration_ms: Date.now() - startedAt,
        error_code: this.getErrorCode(err),
        error_message: err?.message || 'Unknown error',
      });
      throw err;
    }
  }

  async deleteAllMails(accessToken: string, mailbox: string, proxyId?: number, logContext?: GraphLogContext): Promise<void> {
    const startedAt = Date.now();
    logger.info({
      event: 'graph_delete_all_mails',
      status: 'started',
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox,
      proxy_id: proxyId,
      protocol: 'graph',
      provider: logContext?.provider || 'graph',
      operation: logContext?.operation || 'delete_all_mails',
    });

    try {
      const mails = await this.fetchMails(accessToken, mailbox, 10000, proxyId, {
        ...logContext,
        mailbox,
        provider: 'graph',
        operation: 'delete_all_mails_list',
      });
      const batchSize = 10;
      let failedDeleteCount = 0;

      for (let i = 0; i < mails.length; i += batchSize) {
        const batch = mails.slice(i, i + batchSize);
        const settled = await Promise.allSettled(batch.map((m) => this.deleteMail(accessToken, m.mail_id!, proxyId, {
          ...logContext,
          mailbox,
          provider: 'graph',
          operation: 'delete_mail',
        })));

        const failedInBatch = settled.filter((item) => item.status === 'rejected').length;
        failedDeleteCount += failedInBatch;

        if (failedInBatch > 0) {
          logger.warn({
            event: 'graph_delete_all_mails_batch_partial_failed',
            status: 'partial_failed',
            request_id: logContext?.request_id || 'unknown',
            job_id: logContext?.job_id,
            account_id: logContext?.account_id,
            account_email: logContext?.account_email,
            mailbox,
            proxy_id: proxyId,
            protocol: 'graph',
            provider: logContext?.provider || 'graph',
            operation: logContext?.operation || 'delete_all_mails',
            batch_start: i,
            batch_size: batch.length,
            failed_in_batch: failedInBatch,
          });
        }
      }

      if (failedDeleteCount > 0) {
        throw new Error(`Graph delete all mails partially failed: ${failedDeleteCount} messages not deleted`);
      }

      logger.info({
        event: 'graph_delete_all_mails',
        status: 'succeeded',
        request_id: logContext?.request_id || 'unknown',
        job_id: logContext?.job_id,
        account_id: logContext?.account_id,
        account_email: logContext?.account_email,
        mailbox,
        proxy_id: proxyId,
        protocol: 'graph',
        provider: logContext?.provider || 'graph',
        operation: logContext?.operation || 'delete_all_mails',
        total_target_count: mails.length,
        failed_delete_count: failedDeleteCount,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err: any) {
      logger.error({
        event: 'graph_delete_all_mails',
        status: 'failed',
        request_id: logContext?.request_id || 'unknown',
        job_id: logContext?.job_id,
        account_id: logContext?.account_id,
        account_email: logContext?.account_email,
        mailbox,
        proxy_id: proxyId,
        protocol: 'graph',
        provider: logContext?.provider || 'graph',
        operation: logContext?.operation || 'delete_all_mails',
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });
      throw err;
    }
  }

  private async requestWithRetry(params: {
    url: string;
    method: GraphRequestMethod;
    accessToken: string;
    agent?: unknown;
    dispatcher?: unknown;
    type?: string;
    baseLog: Record<string, unknown>;
    clientRequestId: string;
  }): Promise<GraphRequestResult> {
    const { url, method, accessToken, agent, dispatcher, type, baseLog, clientRequestId } = params;
    let attempt = 1;

    while (attempt <= MAX_RETRY_ATTEMPTS) {
      const attemptStartedAt = Date.now();
      try {
        const response = await this.executeGraphRequest(url, method, accessToken, clientRequestId, {
          agent,
          dispatcher,
          type,
        });

        const retryAfterMs = this.getRetryAfterMs(response);
        if (this.isRetryableStatus(response.status) && attempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = this.computeRetryDelayMs(retryAfterMs, attempt);
          await this.drainResponseBody(response);
          logger.warn({
            event: 'graph_request_retry',
            status: 'retrying',
            ...baseLog,
            status_code: response.status,
            retry_after: retryAfterMs ?? null,
            retry_delay_ms: delayMs,
            attempt,
            duration_ms: Date.now() - attemptStartedAt,
          });
          await this.sleep(delayMs);
          attempt += 1;
          continue;
        }

        return {
          response,
          attempt,
          retry_after: retryAfterMs,
        };
      } catch (error: unknown) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const retryable = this.isTransientNetworkError(normalizedError);

        if (retryable && attempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = this.computeBackoffMs(attempt);
          logger.warn({
            event: 'graph_request_retry',
            status: 'retrying',
            ...baseLog,
            attempt,
            retry_after: null,
            error_code: this.getErrorCode(normalizedError),
            error_message: normalizedError.message,
            duration_ms: Date.now() - attemptStartedAt,
          });
          await this.sleep(delayMs);
          attempt += 1;
          continue;
        }

        const typedError = normalizedError as Error & { attempt?: number; client_request_id?: string };
        typedError.attempt = attempt;
        typedError.client_request_id = clientRequestId;
        throw typedError;
      }
    }

    throw new Error('Graph request exceeded retry limit');
  }

  private async executeGraphRequest(
    url: string,
    method: GraphRequestMethod,
    accessToken: string,
    clientRequestId: string,
    proxy: { agent?: unknown; dispatcher?: unknown; type?: string }
  ): Promise<any> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'client-request-id': clientRequestId,
      'return-client-request-id': 'true',
    };

    if (proxy.type === 'socks5' && proxy.agent) {
      const nodefetch = require('node-fetch');
      return nodefetch(url, {
        method,
        agent: proxy.agent,
        headers,
      });
    }

    const { fetch: undiciFetch } = require('undici');
    const opts: any = {
      method,
      headers,
    };
    if (proxy.dispatcher) {
      opts.dispatcher = proxy.dispatcher;
    }
    return undiciFetch(url, opts);
  }

  private buildClientRequestId(requestId?: string): string {
    const prefix = requestId && requestId !== 'unknown'
      ? requestId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
      : 'req';
    const suffix = crypto.randomBytes(8).toString('hex');
    return `${prefix}-${suffix}`;
  }

  private getRetryAfterMs(response: any): number | undefined {
    const retryAfterRaw = response?.headers?.get?.('retry-after');
    if (!retryAfterRaw) return undefined;

    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.floor(seconds * 1000);
    }

    const dateMs = Date.parse(retryAfterRaw);
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now());
    }

    return undefined;
  }

  private isRetryableStatus(statusCode: number): boolean {
    return RETRYABLE_STATUS_CODES.has(statusCode);
  }

  private isTransientNetworkError(error: Error & { code?: string; cause?: any }): boolean {
    const code = `${error.code || error.cause?.code || ''}`.toUpperCase();
    if (!code) {
      return error.name === 'FetchError' || error.name === 'AbortError';
    }

    return [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
      'UND_ERR_REQUEST_TIMEOUT',
    ].includes(code);
  }

  private computeBackoffMs(attempt: number): number {
    const expDelay = Math.min(BASE_RETRY_DELAY_MS * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
    const jitter = Math.floor(Math.random() * 150);
    return expDelay + jitter;
  }

  private computeRetryDelayMs(retryAfterMs: number | undefined, attempt: number): number {
    if (Number.isFinite(retryAfterMs)) {
      return Math.min(Math.max(0, retryAfterMs as number), MAX_SERVER_RETRY_AFTER_MS);
    }
    return this.computeBackoffMs(attempt);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async drainResponseBody(response: any): Promise<void> {
    try {
      if (response && typeof response.text === 'function') {
        await response.text();
      }
    } catch {
      // ignore drain errors
    }
  }

  private getErrorCode(error: unknown): string {
    if (typeof error === 'object' && error !== null) {
      const code = (error as { code?: unknown; cause?: { code?: unknown } }).code;
      if (typeof code === 'string' && code.trim()) return code;

      const causeCode = (error as { cause?: { code?: unknown } }).cause?.code;
      if (typeof causeCode === 'string' && causeCode.trim()) return causeCode;
    }
    return 'GRAPH_REQUEST_ERROR';
  }
}
