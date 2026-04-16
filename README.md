# Outlook 邮箱管理器

一个用于批量管理 Microsoft Outlook 邮箱账户的全栈应用。后端基于 Koa + TypeScript + SQLite，收信链路为 **Graph API 优先，IMAP 降级，缓存兜底**。

## 界面预览

| 仪表盘 | 邮箱管理 |
|:---:|:---:|
| ![仪表盘页面](docs/screenshots/仪表盘页面.png) | ![邮箱管理页面](docs/screenshots/邮箱管理页面.png) |

| 邮件查看 | 移动端 |
|:---:|:---:|
| ![邮件查看弹窗](docs/screenshots/邮件查看弹窗.png) | ![移动端效果](docs/screenshots/移动端效果.png) |

## 技术栈

- **Server**: Node.js + Koa 3 + TypeScript + SQLite (better-sqlite3)
- **Web**: React + Vite + TypeScript + Tailwind
- **Mail**: Microsoft Graph API / IMAP(XOAUTH2)
- **Proxy**: SOCKS5 / HTTP
- **Log**: Winston JSON 文件落盘 + 脱敏

## 核心能力

- 邮箱账号管理（导入/导出/标签）
- Graph→IMAP 自动降级拉信
- 批量拉信任务（job）
- 批量任务详情页（状态、子任务、日志、取消）
- 结构化日志 + request_id 追踪
- 健康探针 / 就绪探针
- 轻量审计事件（高价值动作）
- 只读模式（READ_ONLY_MODE）

---

## 目录结构

```text
Outlook-Mail-Manager/
├── server/
│   ├── src/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── database/
│   │   ├── middlewares/
│   │   ├── models/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── types/
│   │   └── utils/
│   └── data/
├── web/
│   └── src/
└── .env.example
```

---

## 快速开始（pnpm）

### 1) 安装依赖

> 本仓库不是单一 pnpm workspace，建议分别安装根目录与子项目依赖。

```bash
# 根目录（开发脚本工具）
pnpm install

# 后端依赖
pnpm -C server install

# 前端依赖
pnpm -C web install
```

### 2) 配置环境变量

```bash
cp .env.example .env
```

常用配置：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 后端端口 |
| `LOG_LEVEL` | `info` | 日志级别 |
| `LOG_DIR` | `./data/logs` | 日志目录（相对 server） |
| `DB_PATH` | `./data/outlook.db` | SQLite 文件路径（相对 server） |
| `ACCESS_PASSWORD` | 空 | 可选 API 访问密码 |
| `MAIL_FETCH_ENABLED` | `true` | 是否允许拉信 |
| `MAIL_CLEAR_REMOTE_ENABLED` | `false` | 是否允许远端清空邮箱 |
| `BULK_PULL_ENABLED` | `true` | 是否允许批量拉信 |
| `READ_ONLY_MODE` | `false` | 只读模式（拒绝写操作） |
| `DEBUG_LOG_ENABLED` | `false` | debug 日志开关 |

### 3) 开发模式

```bash
pnpm -C server dev
pnpm -C web dev
```

- Web: `http://localhost:5173`
- Server: `http://localhost:3000`

### 4) 构建

```bash
pnpm -C server build
pnpm -C web build
```

### 5) 运行（生产）

```bash
pnpm -C server start
```

---

## 健康检查与就绪检查

### `GET /api/healthz`
- 基础存活检查（进程/时间戳等）

### `GET /api/readyz`
- 就绪检查（数据库可用、日志目录可写）
- 失败时返回 503

---

## API 概览

### 账号 `/api/accounts`
- `GET /`
- `POST /`
- `PUT /:id`
- `DELETE /:id`
- `POST /batch-delete`
- `POST /import`
- `POST /import-preview`
- `POST /import-confirm`
- `POST /export`
- `POST /:id/tags`

### 邮件 `/api/mails`
- `POST /fetch`
- `POST /fetch-new`
- `DELETE /clear`
- `GET /cached`

### 代理 `/api/proxies`
- `GET /`
- `POST /`
- `PUT /:id`
- `DELETE /:id`
- `POST /:id/test`
- `PUT /:id/default`

### 标签 `/api/tags`
- `GET /`
- `POST /`
- `PUT /:id`
- `DELETE /:id`

### 备份 `/api/backup`
- `GET /download`
- `POST /restore`

### 批量任务 `/api/bulk-mail-jobs`
- `POST /` 创建并启动任务
- `GET /:jobId` 查询任务状态/进度
- `GET /:jobId/items` 查询子任务分页
- `GET /:jobId/logs` 查询任务日志分页
- `POST /:jobId/cancel` 取消任务（queued/running）

### 其它
- `GET /api/dashboard/stats`
- `GET /api/auth/check`
- `POST /api/auth/login`

---

## 批量任务状态

- Job: `queued | running | completed | partial_success | failed | cancelled`
- Item: `queued | running | success | failed | cancelled`

日志字段建议追踪：
- `request_id`
- `job_id`
- `account_id`
- `mailbox`
- `provider`
- `status`
- `duration_ms`

---

## 审计能力（audit_events）

仅记录高价值事件，不记录普通运行日志。

### 表结构字段
- `id`
- `ts`
- `actor_type`
- `actor_id`
- `action`
- `target_type`
- `target_id`
- `mailbox`
- `status`
- `reason`
- `request_id`
- `job_id`
- `extra_json`

### 已覆盖动作（示例）
- `mail.fetch.manual`
- `mail.clear`
- `proxy.create / proxy.update / proxy.delete / proxy.set_default`
- `guard.read_only.reject`
- `bulk.job.start / bulk.job.cancel / bulk.job.complete / bulk.job.fail`

> 审计 `extra_json` 走脱敏和敏感字段裁剪，不写入邮件正文/附件内容。

---

## P0~P3 验证建议

### P0（透传 / Graph 重试 / client-request-id）
1. 创建 bulk 任务后查看日志，确认同一条链路可按 `request_id + job_id` 串联。
2. 触发 Graph 限流/临时错误，确认存在有限重试日志：
   - `event=graph_request_retry`
   - 包含 `attempt/status_code/retry_after/client_request_id`

### P1（bulk logs + cancel + 前端详情）
1. `GET /api/bulk-mail-jobs/:jobId/logs` 可返回分页数据。
2. `POST /api/bulk-mail-jobs/:jobId/cancel` 可取消 queued/running 任务。
3. 前端 `/bulk-jobs/:jobId` 可查看任务信息、子任务、日志并执行取消。

### P2（audit）
1. 执行一次手动拉信/清空邮箱/代理修改。
2. 查询 `audit_events`，确认写入对应 action。
3. 开启 `READ_ONLY_MODE=true` 后触发清空邮箱，确认落 `guard.read_only.reject`。

### P3（回归测试）
```bash
pnpm -C server test
```

测试文件位置：`server/src/tests/p3-regression.test.ts`

覆盖关键回归点：
- bulk request_id/job_id 透传
- Graph 重试逻辑
- bulk logs/cancel API 处理
- audit 写入封装
- 只读模式拒绝审计

### 一键验证命令（P0~P3）
```bash
pnpm -C server build
pnpm -C server test
pnpm -C web build
```

---

## 致谢

本仓库是基于上游项目的二次维护与增强版本，感谢上游作者与贡献者：

- 上游仓库：[`aa1125573296-svg/Outlook-Mail-Manager`](https://github.com/aa1125573296-svg/Outlook-Mail-Manager)
- 当前维护 Fork：[`xianyudd/Outlook-Mail-Manager`](https://github.com/xianyudd/Outlook-Mail-Manager)

## License

MIT
