import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, RefreshCw, Search } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { bulkJobApi } from '../lib/api';
import type { BulkMailJob, BulkMailJobItem, BulkMailJobLog, BulkMailJobStatus, PaginatedResponse } from '../types';

const PAGE_SIZE = 20;

const getErrorMessage = (error: unknown) => error instanceof Error ? error.message : '';

const statusClassMap: Record<BulkMailJobStatus, string> = {
  queued: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300',
  completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  partial_success: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  cancelled: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200',
};

function formatTime(value: string | null | undefined) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatMailboxes(mailboxesJson: string) {
  try {
    const parsed = JSON.parse(mailboxesJson);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.join(', ') : '-';
  } catch {
    return '-';
  }
}

function renderPagination<T>(
  pagination: PaginatedResponse<T>,
  onPageChange: (page: number) => void,
  loading: boolean
) {
  const totalPages = Math.max(1, Math.ceil(pagination.total / pagination.pageSize));

  if (pagination.total <= pagination.pageSize) {
    return null;
  }

  return (
    <div className="flex items-center justify-between border-t border-zinc-200 dark:border-zinc-800 px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400">
      <span>共 {pagination.total} 条</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, pagination.page - 1))}
          disabled={loading || pagination.page <= 1}
          className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          上一页
        </button>
        <span>
          {pagination.page} / {totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, pagination.page + 1))}
          disabled={loading || pagination.page >= totalPages}
          className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          下一页
        </button>
      </div>
    </div>
  );
}

export default function BulkJobs() {
  const { jobId: routeJobId } = useParams<{ jobId?: string }>();
  const navigate = useNavigate();

  const [jobIdInput, setJobIdInput] = useState(routeJobId || '');
  const [job, setJob] = useState<BulkMailJob | null>(null);

  const [items, setItems] = useState<PaginatedResponse<BulkMailJobItem>>({
    list: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [logs, setLogs] = useState<PaginatedResponse<BulkMailJobLog>>({
    list: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
  });

  const [itemPage, setItemPage] = useState(1);
  const [logPage, setLogPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentJobId = (routeJobId || '').trim();

  useEffect(() => {
    setJobIdInput(currentJobId);
    setItemPage(1);
    setLogPage(1);
  }, [currentJobId]);

  const fetchDetail = useCallback(async () => {
    if (!currentJobId) {
      setJob(null);
      setItems({ list: [], total: 0, page: 1, pageSize: PAGE_SIZE });
      setLogs({ list: [], total: 0, page: 1, pageSize: PAGE_SIZE });
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [jobDetail, jobItems, jobLogs] = await Promise.all([
        bulkJobApi.detail(currentJobId),
        bulkJobApi.items(currentJobId, { page: itemPage, pageSize: PAGE_SIZE }),
        bulkJobApi.logs(currentJobId, { page: logPage, pageSize: PAGE_SIZE }),
      ]);

      setJob(jobDetail);
      setItems(jobItems);
      setLogs(jobLogs);
    } catch (err: unknown) {
      setError(getErrorMessage(err) || '加载任务详情失败');
      setJob(null);
    } finally {
      setLoading(false);
    }
  }, [currentJobId, itemPage, logPage]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const canCancel = useMemo(() => {
    if (!job) return false;
    if (typeof job.can_cancel === 'boolean') return job.can_cancel;
    return job.status === 'queued' || job.status === 'running';
  }, [job]);

  const progressPercent = useMemo(() => {
    if (!job) return 0;
    if (job.progress?.percent !== undefined) return job.progress.percent;
    if (!job.total_accounts) return 0;
    return Number(((job.processed_accounts / job.total_accounts) * 100).toFixed(2));
  }, [job]);

  const handleLookup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = jobIdInput.trim();
    if (!value) {
      toast.error('请输入任务 ID');
      return;
    }
    navigate(`/bulk-jobs/${encodeURIComponent(value)}`);
  };

  const handleCancel = async () => {
    if (!currentJobId || !canCancel || canceling) return;
    setCanceling(true);
    try {
      await bulkJobApi.cancel(currentJobId);
      toast.success('取消请求已提交');
      await fetchDetail();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err) || '取消任务失败');
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">批量任务详情</h1>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">查看任务状态、执行明细和日志</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchDetail()}
            disabled={loading || !currentJobId}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </button>
          <button
            onClick={handleCancel}
            disabled={!canCancel || canceling}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Ban className="h-4 w-4" />
            {canceling ? '取消中...' : '取消任务'}
          </button>
        </div>
      </div>

      <form onSubmit={handleLookup} className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="mb-2 block text-sm font-medium text-zinc-700 dark:text-zinc-300" htmlFor="jobIdInput">
          任务 ID
        </label>
        <div className="flex gap-2">
          <input
            id="jobIdInput"
            value={jobIdInput}
            onChange={(event) => setJobIdInput(event.target.value)}
            placeholder="输入 job_xxx"
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none ring-blue-500 transition focus:ring-2 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Search className="h-4 w-4" />
            查看
          </button>
        </div>
      </form>

      {!currentJobId && (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
          请输入任务 ID 并点击“查看”加载详情
        </div>
      )}

      {currentJobId && loading && !job && (
        <div className="rounded-xl border border-zinc-200 bg-white p-8 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
          正在加载任务详情...
        </div>
      )}

      {currentJobId && error && !loading && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {currentJobId && job && (
        <>
          <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{job.name}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{job.job_id}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusClassMap[job.status] || statusClassMap.failed}`}>
                {job.status}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/70">
                <p className="text-zinc-500 dark:text-zinc-400">邮箱范围</p>
                <p className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">{formatMailboxes(job.mailboxes_json)}</p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/70">
                <p className="text-zinc-500 dark:text-zinc-400">配置</p>
                <p className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">top={job.top} / batch={job.batch_size} / workers={job.workers}</p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/70">
                <p className="text-zinc-500 dark:text-zinc-400">进度</p>
                <p className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">
                  {job.processed_accounts}/{job.total_accounts} ({progressPercent}%)
                </p>
              </div>
              <div className="rounded-lg bg-zinc-50 p-3 dark:bg-zinc-800/70">
                <p className="text-zinc-500 dark:text-zinc-400">邮件统计</p>
                <p className="mt-1 font-medium text-zinc-900 dark:text-zinc-100">INBOX {job.inbox_total} / Junk {job.junk_total} / Total {job.mail_total}</p>
              </div>
            </div>

            <div className="mt-4 h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.max(0, Math.min(progressPercent, 100))}%` }} />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 text-xs text-zinc-500 dark:text-zinc-400 md:grid-cols-2 xl:grid-cols-4">
              <p>request_id: {job.request_id || '-'}</p>
              <p>proxy_id: {job.proxy_id ?? '-'}</p>
              <p>创建: {formatTime(job.created_at)}</p>
              <p>完成: {formatTime(job.finished_at)}</p>
            </div>

            {job.status === 'cancelled' && (
              <div className="mt-4 rounded-lg border border-zinc-300 bg-zinc-100 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                该任务已取消。
              </div>
            )}
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">子任务执行列表</h2>
            </div>
            {items.list.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">暂无子任务记录</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-zinc-50 text-xs uppercase text-zinc-500 dark:bg-zinc-800/50 dark:text-zinc-400">
                    <tr>
                      <th className="px-4 py-2 text-left">邮箱</th>
                      <th className="px-4 py-2 text-left">状态</th>
                      <th className="px-4 py-2 text-left">批次</th>
                      <th className="px-4 py-2 text-left">拉取数量</th>
                      <th className="px-4 py-2 text-left">耗时</th>
                      <th className="px-4 py-2 text-left">错误</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.list.map((item) => (
                      <tr key={item.id} className="border-t border-zinc-100 dark:border-zinc-800">
                        <td className="px-4 py-2 text-zinc-800 dark:text-zinc-200">{item.account_email}</td>
                        <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{item.status}</td>
                        <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">#{item.batch_no}</td>
                        <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{item.fetched_total} (INBOX {item.inbox_count} / Junk {item.junk_count})</td>
                        <td className="px-4 py-2 text-zinc-600 dark:text-zinc-300">{item.duration_ms ?? '-'} ms</td>
                        <td className="max-w-[420px] truncate px-4 py-2 text-red-600 dark:text-red-300" title={item.error_message || ''}>
                          {item.error_message || '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {renderPagination(items, setItemPage, loading)}
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">任务日志</h2>
            </div>
            {logs.list.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500 dark:text-zinc-400">暂无日志</div>
            ) : (
              <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {logs.list.map((log) => (
                  <div key={log.id} className="space-y-1 px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{log.level}</span>
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{log.event}</span>
                      {log.status && (
                        <span className="rounded bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">{log.status}</span>
                      )}
                      <span className="text-zinc-500 dark:text-zinc-400">{formatTime(log.created_at)}</span>
                    </div>
                    <p className="text-zinc-800 dark:text-zinc-200">{log.message || '-'}</p>
                    <div className="text-xs text-zinc-500 dark:text-zinc-400">
                      request_id: {log.request_id || '-'} · account: {log.account_email || '-'}
                    </div>
                    {log.error_code && <div className="text-xs text-red-600 dark:text-red-300">error_code: {log.error_code}</div>}
                  </div>
                ))}
              </div>
            )}
            {renderPagination(logs, setLogPage, loading)}
          </div>
        </>
      )}
    </div>
  );
}
