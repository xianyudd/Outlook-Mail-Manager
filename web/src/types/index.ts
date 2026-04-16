// ============ 账户 ============
export interface Account {
  id: number;
  email: string;
  password: string;
  client_id: string;
  refresh_token: string;
  remark: string;
  status: 'active' | 'inactive' | 'error';
  last_synced_at: string | null;
  token_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
  tags: Tag[];
}

// ============ 标签 ============
export interface Tag {
  id: number;
  name: string;
  color: string;
  created_at: string;
}

// ============ 邮件 ============
export interface MailMessage {
  id: number;
  account_id: number;
  mailbox: 'INBOX' | 'Junk';
  mail_id: string;
  sender: string;
  sender_name: string;
  subject: string;
  text_content: string;
  html_content: string;
  mail_date: string;
  is_read: boolean;
  cached_at: string;
}

// ============ 代理 ============
export interface Proxy {
  id: number;
  name: string;
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username: string;
  password: string;
  is_default: boolean;
  last_tested_at: string | null;
  last_test_ip: string;
  status: 'untested' | 'active' | 'failed';
  created_at: string;
}

// ============ API ============
export interface ApiResponse<T> {
  code: number;
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ImportRequest {
  content: string;
  separator: string;
  format: string[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface ImportPreviewResult {
  newItems: { line: number; email: string; [key: string]: any }[];
  duplicates: { line: number; email: string; [key: string]: any }[];
  errors: string[];
}

export interface ExportRequest {
  ids?: number[];
  separator?: string;
  format?: string[];
}

export interface DashboardStats {
  totalAccounts: number;
  activeAccounts: number;
  totalInboxMails: number;
  totalJunkMails: number;
  totalProxies: number;
  activeProxies: number;
  recentMails: MailMessage[];
  accountStats: {
    account_id: number;
    email: string;
    inbox_count: number;
    junk_count: number;
  }[];
  expiringTokens: number;
  errorAccounts: number;
  unusedAccounts: number;
}

export interface ProxyTestResult {
  ip: string;
  latency: number;
  status: 'active' | 'failed';
}

export interface FetchMailsResult {
  mails: MailMessage[];
  total: number;
  protocol: 'graph' | 'imap';
  cached: boolean;
}

// ============ 批量任务 ============
export type BulkMailJobStatus = 'queued' | 'running' | 'completed' | 'partial_success' | 'failed' | 'cancelled';
export type BulkMailJobItemStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type BulkMailJobLogLevel = 'info' | 'warn' | 'error';

export interface BulkMailJobProgress {
  total_accounts: number;
  processed_accounts: number;
  success_accounts: number;
  failed_accounts: number;
  current_batch: number;
  total_batches: number;
  percent: number;
}

export interface BulkMailJob {
  id: number;
  job_id: string;
  name: string;
  status: BulkMailJobStatus;
  mailboxes_json: string;
  top: number;
  batch_size: number;
  workers: number;
  proxy_id: number | null;
  total_accounts: number;
  processed_accounts: number;
  success_accounts: number;
  failed_accounts: number;
  current_batch: number;
  total_batches: number;
  inbox_total: number;
  junk_total: number;
  mail_total: number;
  request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  progress?: BulkMailJobProgress;
  worker_running?: boolean;
  can_cancel?: boolean;
}

export interface BulkMailJobItem {
  id: number;
  job_id: string;
  batch_no: number;
  account_id: number;
  account_email: string;
  status: BulkMailJobItemStatus;
  retry_count: number;
  mailboxes_json: string;
  top: number;
  inbox_count: number;
  junk_count: number;
  fetched_total: number;
  request_id: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface BulkMailJobLog {
  id: number;
  job_id: string;
  item_id: number | null;
  request_id: string | null;
  account_email: string | null;
  level: BulkMailJobLogLevel;
  event: string;
  status: string | null;
  error_code: string | null;
  message: string | null;
  meta_json: string | null;
  created_at: string;
}
