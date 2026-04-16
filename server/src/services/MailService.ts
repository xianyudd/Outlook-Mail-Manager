import { AccountModel } from '../models/Account';
import { MailCacheModel } from '../models/MailCache';
import { OAuthService } from './OAuthService';
import { GraphApiService } from './GraphApiService';
import { ImapService } from './ImapService';
import { FetchMailsResult } from '../types';
import logger from '../utils/logger';

const accountModel = new AccountModel();
const cacheModel = new MailCacheModel();
const oauthService = new OAuthService();
const graphService = new GraphApiService();
const imapService = new ImapService();

export interface MailServiceLogContext {
  request_id: string;
  job_id?: string;
  account_id?: number;
  account_email?: string;
  mailbox?: string;
  provider?: string;
  operation?: string;
  proxy_id?: number;
  protocol?: 'graph' | 'imap';
}

export class MailService {
  async fetchMails(
    accountId: number,
    mailbox: string,
    proxyId?: number,
    top = 50,
    logContext?: Partial<MailServiceLogContext>
  ): Promise<FetchMailsResult> {
    const startedAt = Date.now();
    const account = accountModel.getById(accountId);
    if (!account) throw new Error('Account not found');

    const baseLogContext: MailServiceLogContext = {
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: accountId,
      account_email: account.email,
      mailbox,
      provider: logContext?.provider || 'microsoft',
      operation: logContext?.operation || 'fetch_mails',
      proxy_id: proxyId,
    };

    logger.info({
      event: 'mail_service_fetch',
      status: 'started',
      ...baseLogContext,
      top,
      fallback_used: false,
      cached: false,
    });

    // 尝试 Graph API
    try {
      const graphStartedAt = Date.now();
      const token = await oauthService.refreshGraphToken(account.client_id, account.refresh_token, proxyId, {
        ...baseLogContext,
        protocol: 'graph',
        provider: 'graph',
      });
      // Token rotation 回写
      accountModel.updateTokenRefreshTime(accountId, token.refresh_token);

      if (token.has_mail_scope) {
        const mails = await graphService.fetchMails(token.access_token, mailbox, top, proxyId, {
          ...baseLogContext,
          protocol: 'graph',
          provider: 'graph',
        });
        cacheModel.upsert(accountId, mailbox, mails);
        accountModel.updateSyncTime(accountId);

        logger.info({
          event: 'mail_service_fetch',
          status: 'succeeded',
          ...baseLogContext,
          protocol: 'graph',
          provider: 'graph',
          protocol_final: 'graph',
          mail_count: mails.length,
          cached: false,
          fallback_used: false,
          duration_ms: Date.now() - startedAt,
          graph_duration_ms: Date.now() - graphStartedAt,
        });

        return { mails: mails as any, total: mails.length, protocol: 'graph', cached: false };
      }

      logger.warn({
        event: 'mail_service_fetch_fallback',
        status: 'fallback',
        ...baseLogContext,
        protocol: 'graph',
        provider: 'graph',
        fallback_reason: 'graph_missing_mail_scope',
        fallback_used: true,
        duration_ms: Date.now() - graphStartedAt,
      });
    } catch (err: any) {
      logger.warn({
        event: 'mail_service_fetch_fallback',
        status: 'fallback',
        ...baseLogContext,
        protocol: 'graph',
        provider: 'graph',
        fallback_reason: 'graph_fetch_failed',
        fallback_used: true,
        error_message: err?.message || 'Unknown error',
      });
    }

    // 回退 IMAP
    try {
      const imapStartedAt = Date.now();
      // 重新读取账户（可能 Graph 阶段已更新了 refresh_token）
      const freshAccount = accountModel.getById(accountId);
      const refreshToken = freshAccount?.refresh_token || account.refresh_token;

      const token = await oauthService.refreshImapToken(account.client_id, refreshToken, proxyId, {
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
      });
      // Token rotation 回写
      accountModel.updateTokenRefreshTime(accountId, token.refresh_token);

      const authString = imapService.generateAuthString(account.email, token.access_token);
      const mails = await imapService.fetchMails(account.email, authString, mailbox, top, {
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
      });
      cacheModel.upsert(accountId, mailbox, mails);
      accountModel.updateSyncTime(accountId);

      logger.info({
        event: 'mail_service_fetch',
        status: 'succeeded',
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
        protocol_final: 'imap',
        mail_count: mails.length,
        cached: false,
        fallback_used: true,
        duration_ms: Date.now() - startedAt,
        imap_duration_ms: Date.now() - imapStartedAt,
      });

      return { mails: mails as any, total: mails.length, protocol: 'imap', cached: false };
    } catch (err: any) {
      logger.error({
        event: 'mail_service_fetch_imap_failed',
        status: 'failed',
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
        fallback_used: true,
        error_message: err?.message || 'Unknown error',
      });

      // 两种方式都失败，标记账户为 error
      accountModel.markError(accountId);

      // 返回缓存
      const cached = cacheModel.getByAccount(accountId, mailbox, 1, top);
      if (cached.list.length > 0) {
        logger.warn({
          event: 'mail_service_fetch_cached_fallback',
          status: 'succeeded',
          ...baseLogContext,
          protocol: 'imap',
          provider: 'cache',
          protocol_final: 'cache',
          fallback_reason: 'both_protocols_failed_return_cached',
          fallback_used: true,
          cached: true,
          mail_count: cached.total,
          duration_ms: Date.now() - startedAt,
        });
        return { mails: cached.list, total: cached.total, protocol: 'graph', cached: true };
      }

      logger.error({
        event: 'mail_service_fetch',
        status: 'failed',
        ...baseLogContext,
        provider: 'none',
        protocol_final: 'none',
        fallback_reason: 'both_protocols_failed_no_cache',
        fallback_used: true,
        cached: false,
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });

      throw new Error(`Both Graph API and IMAP failed: ${err.message}`);
    }
  }

  async clearMailbox(
    accountId: number,
    mailbox: string,
    proxyId?: number,
    logContext?: Partial<MailServiceLogContext>
  ): Promise<void> {
    const startedAt = Date.now();
    const account = accountModel.getById(accountId);
    if (!account) throw new Error('Account not found');

    const baseLogContext: MailServiceLogContext = {
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: accountId,
      account_email: account.email,
      mailbox,
      provider: logContext?.provider || 'microsoft',
      operation: logContext?.operation || 'clear_mailbox',
      proxy_id: proxyId,
    };

    logger.info({
      event: 'mail_service_clear_mailbox',
      status: 'started',
      ...baseLogContext,
    });

    // 尝试 Graph API 删除
    try {
      const graphStartedAt = Date.now();
      const token = await oauthService.refreshGraphToken(account.client_id, account.refresh_token, proxyId, {
        ...baseLogContext,
        protocol: 'graph',
        provider: 'graph',
      });
      accountModel.updateTokenRefreshTime(accountId, token.refresh_token);

      if (token.has_mail_scope) {
        await graphService.deleteAllMails(token.access_token, mailbox, proxyId, {
          ...baseLogContext,
          protocol: 'graph',
          provider: 'graph',
        });

        logger.info({
          event: 'mail_service_clear_mailbox',
          status: 'succeeded',
          ...baseLogContext,
          protocol: 'graph',
          provider: 'graph',
          protocol_final: 'graph',
          fallback_used: false,
          duration_ms: Date.now() - startedAt,
          graph_duration_ms: Date.now() - graphStartedAt,
        });

        return;
      }

      logger.warn({
        event: 'mail_service_clear_mailbox_fallback',
        status: 'fallback',
        ...baseLogContext,
        protocol: 'graph',
        provider: 'graph',
        fallback_reason: 'graph_missing_mail_scope',
        fallback_used: true,
      });
    } catch (err: any) {
      logger.warn({
        event: 'mail_service_clear_mailbox_fallback',
        status: 'fallback',
        ...baseLogContext,
        protocol: 'graph',
        provider: 'graph',
        fallback_reason: 'graph_delete_failed',
        fallback_used: true,
        error_message: err?.message || 'Unknown error',
      });
    }

    // 回退 IMAP 删除
    try {
      const imapStartedAt = Date.now();
      const freshAccount = accountModel.getById(accountId);
      const refreshToken = freshAccount?.refresh_token || account.refresh_token;

      const token = await oauthService.refreshImapToken(account.client_id, refreshToken, proxyId, {
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
      });
      accountModel.updateTokenRefreshTime(accountId, token.refresh_token);

      const authString = imapService.generateAuthString(account.email, token.access_token);
      await imapService.clearMailbox(account.email, authString, mailbox, {
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
      });

      logger.info({
        event: 'mail_service_clear_mailbox',
        status: 'succeeded',
        ...baseLogContext,
        protocol: 'imap',
        provider: 'imap',
        protocol_final: 'imap',
        fallback_used: true,
        duration_ms: Date.now() - startedAt,
        imap_duration_ms: Date.now() - imapStartedAt,
      });
    } catch (err: any) {
      logger.error({
        event: 'mail_service_clear_mailbox',
        status: 'failed',
        ...baseLogContext,
        provider: 'imap',
        protocol_final: 'imap',
        fallback_used: true,
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });
      throw err;
    }
  }
}
