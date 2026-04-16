import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import { MailMessage } from '../types';
import logger from '../utils/logger';

interface ImapLogContext {
  request_id?: string;
  account_id?: number;
  account_email?: string;
  mailbox?: string;
  proxy_id?: number;
  protocol?: 'graph' | 'imap';
}

export class ImapService {
  generateAuthString(email: string, accessToken: string): string {
    const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
    return Buffer.from(authString).toString('base64');
  }

  fetchMails(
    email: string,
    authString: string,
    mailbox = 'INBOX',
    top = 50,
    logContext?: ImapLogContext
  ): Promise<Partial<MailMessage>[]> {
    const startedAt = Date.now();
    const requestId = logContext?.request_id || 'unknown';

    logger.info({
      event: 'imap_fetch_mails',
      status: 'started',
      request_id: requestId,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email || email,
      mailbox,
      protocol: 'imap',
      top,
    });

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: email,
        password: '',
        xoauth2: authString,
        host: 'outlook.office365.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      } as any);

      const emailList: Partial<MailMessage>[] = [];
      let messageCount = 0;
      let processedCount = 0;

      imap.once('ready', async () => {
        try {
          await new Promise<void>((res, rej) => {
            imap.openBox(mailbox, true, (err) => (err ? rej(err) : res()));
          });

          const results: number[] = await new Promise((res, rej) => {
            imap.search(['ALL'], (err, searchResults) => {
              if (err) return rej(err);
              const sliced = searchResults.slice(-Math.min(top, searchResults.length));
              res(sliced);
            });
          });

          if (results.length === 0) {
            imap.end();
            return;
          }

          messageCount = results.length;
          const f = imap.fetch(results, { bodies: '' });

          f.on('message', (msg) => {
            let uid = '';
            let parsedMailPromise: Promise<any> | null = null;

            msg.once('attributes', (attrs: any) => {
              uid = attrs?.uid ? String(attrs.uid) : '';
            });

            msg.on('body', (stream) => {
              parsedMailPromise = simpleParser(stream as any);
            });

            msg.once('end', () => {
              const parser = parsedMailPromise ?? Promise.resolve(null);
              parser
                .then((mail: any) => {
                  if (!mail) return;

                  const parsedMessageId = typeof mail.messageId === 'string' ? mail.messageId.trim() : '';
                  const stableFallbackSeed = [
                    mail.date?.toISOString?.() || '',
                    mail.subject || '',
                    mail.from?.text || '',
                    (mail.text || '').slice(0, 120),
                  ].join('|');
                  const fallbackId = stableFallbackSeed
                    ? `fallback:${Buffer.from(stableFallbackSeed).toString('base64').slice(0, 120)}`
                    : '';

                  emailList.push({
                    mail_id: uid || parsedMessageId || fallbackId,
                    sender: mail.from?.text || '',
                    sender_name: mail.from?.value?.[0]?.name || '',
                    subject: mail.subject || '',
                    text_content: mail.text || '',
                    html_content: mail.html || '',
                    mail_date: mail.date?.toISOString() || '',
                  });
                })
                .catch((err) => {
                  logger.error({
                    event: 'imap_parse_mail',
                    status: 'failed',
                    request_id: requestId,
                    account_id: logContext?.account_id,
                    account_email: logContext?.account_email || email,
                    mailbox,
                    protocol: 'imap',
                    error_message: err?.message || 'Unknown parse error',
                  });
                })
                .finally(() => {
                  processedCount++;
                  if (processedCount === messageCount) imap.end();
                });
            });
          });

          f.once('error', (err) => {
            logger.error({
              event: 'imap_fetch_mails',
              status: 'failed',
              request_id: requestId,
              account_id: logContext?.account_id,
              account_email: logContext?.account_email || email,
              mailbox,
              protocol: 'imap',
              duration_ms: Date.now() - startedAt,
              error_message: err?.message || 'IMAP fetch error',
            });
            reject(err);
            imap.end();
          });
        } catch (err: any) {
          logger.error({
            event: 'imap_fetch_mails',
            status: 'failed',
            request_id: requestId,
            account_id: logContext?.account_id,
            account_email: logContext?.account_email || email,
            mailbox,
            protocol: 'imap',
            duration_ms: Date.now() - startedAt,
            error_message: err?.message || 'IMAP ready error',
          });
          reject(err);
          imap.end();
        }
      });

      imap.once('error', (err: Error) => {
        logger.error({
          event: 'imap_fetch_mails',
          status: 'failed',
          request_id: requestId,
          account_id: logContext?.account_id,
          account_email: logContext?.account_email || email,
          mailbox,
          protocol: 'imap',
          duration_ms: Date.now() - startedAt,
          error_message: err?.message || 'IMAP connection error',
        });
        reject(err);
      });

      imap.once('end', () => {
        logger.info({
          event: 'imap_fetch_mails',
          status: 'succeeded',
          request_id: requestId,
          account_id: logContext?.account_id,
          account_email: logContext?.account_email || email,
          mailbox,
          protocol: 'imap',
          message_count: messageCount,
          parsed_count: emailList.length,
          duration_ms: Date.now() - startedAt,
        });
        resolve(emailList);
      });

      imap.connect();
    });
  }

  clearMailbox(email: string, authString: string, mailbox = 'INBOX', logContext?: ImapLogContext): Promise<void> {
    const startedAt = Date.now();
    const requestId = logContext?.request_id || 'unknown';

    logger.info({
      event: 'imap_clear_mailbox',
      status: 'started',
      request_id: requestId,
      account_id: logContext?.account_id,
      account_email: logContext?.account_email || email,
      mailbox,
      protocol: 'imap',
    });

    return new Promise((resolve, reject) => {
      const imap = new Imap({
        user: email,
        password: '',
        xoauth2: authString,
        host: 'outlook.office365.com',
        port: 993,
        tls: true,
        tlsOptions: { rejectUnauthorized: false },
      } as any);

      imap.once('ready', async () => {
        try {
          await new Promise<void>((res, rej) => {
            imap.openBox(mailbox, false, (err) => (err ? rej(err) : res()));
          });

          const results: number[] = await new Promise((res, rej) => {
            imap.search(['ALL'], (err, searchResults) => (err ? rej(err) : res(searchResults)));
          });

          if (results.length === 0) {
            logger.info({
              event: 'imap_clear_mailbox',
              status: 'succeeded',
              request_id: requestId,
              account_id: logContext?.account_id,
              account_email: logContext?.account_email || email,
              mailbox,
              protocol: 'imap',
              matched_count: 0,
              deleted_count: 0,
              duration_ms: Date.now() - startedAt,
            });
            imap.end();
            return;
          }

          await new Promise<void>((res, rej) => {
            imap.addFlags(results, ['\\Deleted'], (err) => (err ? rej(err) : res()));
          });

          await new Promise<void>((res, rej) => {
            imap.expunge((err) => (err ? rej(err) : res()));
          });

          logger.info({
            event: 'imap_clear_mailbox',
            status: 'succeeded',
            request_id: requestId,
            account_id: logContext?.account_id,
            account_email: logContext?.account_email || email,
            mailbox,
            protocol: 'imap',
            matched_count: results.length,
            deleted_count: results.length,
            duration_ms: Date.now() - startedAt,
          });
          imap.end();
        } catch (err: any) {
          logger.error({
            event: 'imap_clear_mailbox',
            status: 'failed',
            request_id: requestId,
            account_id: logContext?.account_id,
            account_email: logContext?.account_email || email,
            mailbox,
            protocol: 'imap',
            duration_ms: Date.now() - startedAt,
            error_message: err?.message || 'IMAP clear error',
          });
          reject(err);
          imap.end();
        }
      });

      imap.once('error', (err: Error) => {
        logger.error({
          event: 'imap_clear_mailbox',
          status: 'failed',
          request_id: requestId,
          account_id: logContext?.account_id,
          account_email: logContext?.account_email || email,
          mailbox,
          protocol: 'imap',
          duration_ms: Date.now() - startedAt,
          error_message: err?.message || 'IMAP connection error',
        });
        reject(err);
      });

      imap.once('end', () => resolve());
      imap.connect();
    });
  }
}
