import type {
  ApiResponse,
  PaginatedResponse,
  Account,
  MailMessage,
  Proxy,
  ImportRequest,
  ImportResult,
  ExportRequest,
  DashboardStats,
  ProxyTestResult,
  FetchMailsResult,
  Tag,
  ImportPreviewResult,
  BulkMailJob,
  BulkMailJobItem,
  BulkMailJobLog,
} from '../types';

const API_BASE = '/api';

function qs(params?: Record<string, any>): string {
  if (!params) return '';
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('auth_token');
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const hasBody = options?.body !== undefined && options?.body !== null;
  if (hasBody && !(options?.body instanceof FormData) && !hasHeader(headers, 'Content-Type')) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE}${url}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('auth_token');
    window.dispatchEvent(new Event('auth-required'));
    throw new Error('Unauthorized');
  }

  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(text || `Request failed: HTTP ${res.status}`);
  }

  const json = await res.json() as ApiResponse<T>;
  if (typeof json?.code !== 'number') {
    throw new Error('Invalid response format');
  }
  if (json.code !== 200) throw new Error(json.message || `Request failed: ${json.code}`);
  return json.data;
}

export const accountApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string }) =>
    request<PaginatedResponse<Account>>(`/accounts?${qs(params)}`),
  create: (data: Partial<Account>) =>
    request<Account>('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Account>) =>
    request<Account>(`/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) =>
    request<{ deleted: boolean }>(`/accounts/${id}`, { method: 'DELETE' }),
  batchDelete: (ids: number[]) =>
    request<{ deleted: number }>('/accounts/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
  import: (data: ImportRequest) =>
    request<ImportResult>('/accounts/import', { method: 'POST', body: JSON.stringify(data) }),
  importPreview: (data: ImportRequest) =>
    request<ImportPreviewResult>('/accounts/import-preview', { method: 'POST', body: JSON.stringify(data) }),
  importConfirm: (data: ImportRequest & { mode: 'skip' | 'overwrite' }) =>
    request<ImportResult>('/accounts/import-confirm', { method: 'POST', body: JSON.stringify(data) }),
  export: (data: ExportRequest) =>
    request<{ content: string; count: number }>('/accounts/export', { method: 'POST', body: JSON.stringify(data) }),
};

export const mailApi = {
  fetch: (data: { account_id: number; mailbox: string; proxy_id?: number }) =>
    request<FetchMailsResult>('/mails/fetch', { method: 'POST', body: JSON.stringify(data) }),
  fetchNew: (data: { account_id: number; mailbox: string; proxy_id?: number }) =>
    request<MailMessage | null>('/mails/fetch-new', { method: 'POST', body: JSON.stringify(data) }),
  cached: (params: { account_id: number; mailbox: string; page?: number; pageSize?: number }) =>
    request<PaginatedResponse<MailMessage>>(`/mails/cached?${qs(params)}`),
  clear: (data: { account_id: number; mailbox: string; proxy_id?: number }) =>
    request<{ message: string }>('/mails/clear', { method: 'DELETE', body: JSON.stringify(data) }),
};

export const proxyApi = {
  list: () => request<Proxy[]>('/proxies'),
  create: (data: Partial<Proxy>) =>
    request<Proxy>('/proxies', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<Proxy>) =>
    request<Proxy>(`/proxies/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) =>
    request<{ deleted: boolean }>(`/proxies/${id}`, { method: 'DELETE' }),
  test: (id: number) =>
    request<ProxyTestResult>(`/proxies/${id}/test`, { method: 'POST' }),
  setDefault: (id: number) =>
    request<Proxy>(`/proxies/${id}/default`, { method: 'PUT' }),
};

export const dashboardApi = {
  stats: () => request<DashboardStats>('/dashboard/stats'),
};

export const authApi = {
  check: () => request<{ required: boolean }>('/auth/check'),
  login: (password: string) =>
    request<{ token: string; required: boolean }>('/auth/login', { method: 'POST', body: JSON.stringify({ password }) }),
};

export const bulkJobApi = {
  detail: (jobId: string) =>
    request<BulkMailJob>(`/bulk-mail-jobs/${encodeURIComponent(jobId)}`),
  items: (jobId: string, params?: { page?: number; pageSize?: number }) =>
    request<PaginatedResponse<BulkMailJobItem>>(`/bulk-mail-jobs/${encodeURIComponent(jobId)}/items?${qs(params)}`),
  logs: (jobId: string, params?: { page?: number; pageSize?: number }) =>
    request<PaginatedResponse<BulkMailJobLog>>(`/bulk-mail-jobs/${encodeURIComponent(jobId)}/logs?${qs(params)}`),
  cancel: (jobId: string) =>
    request<{ job_id: string; status: string }>(`/bulk-mail-jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }),
};

export const tagApi = {
  list: () => request<Tag[]>('/tags'),
  create: (data: { name: string; color?: string }) =>
    request<Tag>('/tags', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { name?: string; color?: string }) =>
    request<Tag>(`/tags/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: number) =>
    request<{ deleted: boolean }>(`/tags/${id}`, { method: 'DELETE' }),
  setAccountTags: (accountId: number, tagIds: number[]) =>
    request<{ account_id: number; tag_ids: number[] }>(
      `/accounts/${accountId}/tags`,
      { method: 'POST', body: JSON.stringify({ tag_ids: tagIds }) }
    ),
};
