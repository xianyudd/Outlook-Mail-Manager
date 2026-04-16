import { ProxyService } from './ProxyService';
import logger from '../utils/logger';

const proxyService = new ProxyService();

interface TokenResult {
  access_token: string;
  refresh_token?: string;
  has_mail_scope?: boolean;
  expires_in: number;
}

interface OAuthLogContext {
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

const maskClientId = (clientId: string): string => {
  if (!clientId) return 'unknown';
  if (clientId.length <= 10) return clientId;
  return `${clientId.slice(0, 6)}...${clientId.slice(-4)}`;
};

export class OAuthService {
  async refreshGraphToken(
    clientId: string,
    refreshToken: string,
    proxyId?: number,
    logContext?: OAuthLogContext
  ): Promise<TokenResult> {
    const startedAt = Date.now();
    const { agent, dispatcher, type } = proxyService.getAgent(proxyId, {
      request_id: logContext?.request_id,
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      mailbox: logContext?.mailbox,
      provider: 'graph',
      operation: 'oauth_refresh_graph',
      proxy_id: proxyId,
    });
    const proxyType = type || 'none';
    const baseLog = {
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox: logContext?.mailbox,
      operation: logContext?.operation || 'oauth_refresh_graph',
      proxy_id: proxyId,
      proxy_type: proxyType,
      protocol: 'graph',
      provider: logContext?.provider || 'graph',
      client_id_suffix: maskClientId(clientId),
    };

    logger.info({
      event: 'oauth_refresh_graph',
      status: 'started',
      ...baseLog,
    });

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://graph.microsoft.com/.default offline_access',
    }).toString();

    let response: any;
    if (type === 'socks5' && agent) {
      const nodefetch = require('node-fetch');
      response = await nodefetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        agent,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } else {
      const { fetch: undiciFetch } = require('undici');
      const opts: any = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      response = await undiciFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', opts);
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({
        event: 'oauth_refresh_graph',
        status: 'failed',
        ...baseLog,
        http_status: response.status,
        duration_ms: Date.now() - startedAt,
        error_message: errorText.slice(0, 300),
      });
      throw new Error(`OAuth token refresh failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const hasMailScope = data.scope?.includes('Mail.Read') ?? false;
    const hasNewRefreshToken = !!data.refresh_token;
    const tokenChanged = data.refresh_token && data.refresh_token !== refreshToken;

    logger.info({
      event: 'oauth_refresh_graph',
      status: 'succeeded',
      ...baseLog,
      has_mail_scope: hasMailScope,
      has_new_refresh_token: hasNewRefreshToken,
      refresh_token_changed: !!tokenChanged,
      expires_in: data.expires_in,
      duration_ms: Date.now() - startedAt,
    });

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      has_mail_scope: hasMailScope,
      expires_in: data.expires_in,
    };
  }

  async refreshImapToken(
    clientId: string,
    refreshToken: string,
    proxyId?: number,
    logContext?: OAuthLogContext
  ): Promise<TokenResult> {
    const startedAt = Date.now();
    const { agent, dispatcher, type } = proxyService.getAgent(proxyId, {
      request_id: logContext?.request_id,
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      mailbox: logContext?.mailbox,
      provider: 'imap',
      operation: 'oauth_refresh_imap',
      proxy_id: proxyId,
    });
    const proxyType = type || 'none';
    const baseLog = {
      request_id: logContext?.request_id || 'unknown',
      job_id: logContext?.job_id,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox: logContext?.mailbox,
      operation: logContext?.operation || 'oauth_refresh_imap',
      proxy_id: proxyId,
      proxy_type: proxyType,
      protocol: 'imap',
      provider: logContext?.provider || 'imap',
      client_id_suffix: maskClientId(clientId),
    };

    logger.info({
      event: 'oauth_refresh_imap',
      status: 'started',
      ...baseLog,
    });

    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'offline_access https://outlook.office.com/IMAP.AccessAsUser.All',
    }).toString();

    let response: any;
    if (type === 'socks5' && agent) {
      const nodefetch = require('node-fetch');
      response = await nodefetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        agent,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } else {
      const { fetch: undiciFetch } = require('undici');
      const opts: any = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      response = await undiciFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', opts);
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({
        event: 'oauth_refresh_imap',
        status: 'failed',
        ...baseLog,
        http_status: response.status,
        duration_ms: Date.now() - startedAt,
        error_message: errorText.slice(0, 300),
      });
      throw new Error(`IMAP token refresh failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const hasNewRefreshToken = !!data.refresh_token;
    const tokenChanged = data.refresh_token && data.refresh_token !== refreshToken;

    logger.info({
      event: 'oauth_refresh_imap',
      status: 'succeeded',
      ...baseLog,
      has_new_refresh_token: hasNewRefreshToken,
      refresh_token_changed: !!tokenChanged,
      expires_in: data.expires_in,
      duration_ms: Date.now() - startedAt,
    });

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    };
  }
}
