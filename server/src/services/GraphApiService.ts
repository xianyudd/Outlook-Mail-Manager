import { ProxyService } from './ProxyService';
import { MailMessage } from '../types';
import logger from '../utils/logger';

const proxyService = new ProxyService();

interface GraphLogContext {
  request_id?: string;
  account_id?: number;
  account_email?: string;
  mailbox?: string;
  proxy_id?: number;
  protocol?: 'graph' | 'imap';
}

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
    const { agent, dispatcher, type } = proxyService.getAgent(proxyId);

    const baseLog = {
      request_id: logContext?.request_id || 'unknown',
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox,
      folder,
      top,
      proxy_id: proxyId,
      proxy_type: type || 'none',
      protocol: 'graph',
    };

    logger.info({
      event: 'graph_fetch_mails',
      status: 'started',
      ...baseLog,
    });

    const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${top}`;
    let response: any;

    if (type === 'socks5' && agent) {
      const nodefetch = require('node-fetch');
      response = await nodefetch(url, {
        agent,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      });
    } else {
      const { fetch: undiciFetch } = require('undici');
      const opts: any = {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      };
      if (dispatcher) opts.dispatcher = dispatcher;
      response = await undiciFetch(url, opts);
    }

    if (!response.ok) {
      const errorText = await response.text();
      logger.warn({
        event: 'graph_fetch_mails',
        status: 'failed',
        ...baseLog,
        http_status: response.status,
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
      duration_ms: Date.now() - startedAt,
    });
    return emails;
  }

  async deleteMail(accessToken: string, mailId: string, proxyId?: number, logContext?: GraphLogContext): Promise<void> {
    const startedAt = Date.now();
    const { agent, dispatcher, type } = proxyService.getAgent(proxyId);
    const url = `https://graph.microsoft.com/v1.0/me/messages/${mailId}`;

    try {
      let response: any;
      if (type === 'socks5' && agent) {
        const nodefetch = require('node-fetch');
        response = await nodefetch(url, { method: 'DELETE', agent, headers: { Authorization: `Bearer ${accessToken}` } });
      } else {
        const { fetch: undiciFetch } = require('undici');
        const opts: any = { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } };
        if (dispatcher) opts.dispatcher = dispatcher;
        response = await undiciFetch(url, opts);
      }

      if (response && !response.ok) {
        logger.warn({
          event: 'graph_delete_mail',
          status: 'failed',
          request_id: logContext?.request_id || 'unknown',
          account_id: logContext?.account_id,
          account_email: logContext?.account_email,
          mailbox: logContext?.mailbox,
          proxy_id: proxyId,
          protocol: 'graph',
          mail_id: mailId,
          http_status: response.status,
          duration_ms: Date.now() - startedAt,
        });
      }
    } catch (err: any) {
      logger.error({
        event: 'graph_delete_mail',
        status: 'failed',
        request_id: logContext?.request_id || 'unknown',
        account_id: logContext?.account_id,
        account_email: logContext?.account_email,
        mailbox: logContext?.mailbox,
        proxy_id: proxyId,
        protocol: 'graph',
        mail_id: mailId,
        duration_ms: Date.now() - startedAt,
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
      account_id: logContext?.account_id,
      account_email: logContext?.account_email,
      mailbox,
      proxy_id: proxyId,
      protocol: 'graph',
    });

    try {
      const mails = await this.fetchMails(accessToken, mailbox, 10000, proxyId, logContext);
      const batchSize = 10;
      for (let i = 0; i < mails.length; i += batchSize) {
        const batch = mails.slice(i, i + batchSize);
        await Promise.allSettled(batch.map((m) => this.deleteMail(accessToken, m.mail_id!, proxyId, logContext)));
      }

      logger.info({
        event: 'graph_delete_all_mails',
        status: 'succeeded',
        request_id: logContext?.request_id || 'unknown',
        account_id: logContext?.account_id,
        account_email: logContext?.account_email,
        mailbox,
        proxy_id: proxyId,
        protocol: 'graph',
        total_target_count: mails.length,
        duration_ms: Date.now() - startedAt,
      });
    } catch (err: any) {
      logger.error({
        event: 'graph_delete_all_mails',
        status: 'failed',
        request_id: logContext?.request_id || 'unknown',
        account_id: logContext?.account_id,
        account_email: logContext?.account_email,
        mailbox,
        proxy_id: proxyId,
        protocol: 'graph',
        duration_ms: Date.now() - startedAt,
        error_message: err?.message || 'Unknown error',
      });
      throw err;
    }
  }
}
