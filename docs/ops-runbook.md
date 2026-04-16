# Outlook-Mail-Manager 运维 Runbook（基线）

> 版本：Round1-WorkerD 基线  
> 适用：`Outlook-Mail-Manager`（Koa + TypeScript + SQLite）

## 1. 服务启动

项目目录：`D:\Jason\Documents\Workspace\Project\Outlook-Mail-Manager`

### 后端
```bash
cd /mnt/d/Jason/Documents/Workspace/Project/Outlook-Mail-Manager/server
pnpm install
pnpm dev
```

默认监听：`http://127.0.0.1:3000`

### 前端
```bash
cd /mnt/d/Jason/Documents/Workspace/Project/Outlook-Mail-Manager/web
pnpm install
pnpm dev
```

默认监听：`http://127.0.0.1:5173`

---

## 2. 健康检查接口

- `GET /api/healthz`
  - 用途：进程存活检查
  - 返回：`status / uptime / timestamp / pid`

- `GET /api/readyz`
  - 用途：就绪检查
  - 检查项：
    - SQLite 查询可用（`SELECT 1`）
    - 日志目录可写（临时文件写入+删除）
  - 全部通过：HTTP `200`
  - 任一失败：HTTP `503`

### 路由挂载说明（主分支需补）
本轮只新增了 `server/src/routes/health.ts`，避免和其他 worker 冲突。  
主分支需要在 `server/src/routes/index.ts` 挂载：

```ts
import { healthRoutes } from './health';
router.use('/', healthRoutes.routes(), healthRoutes.allowedMethods());
```

> 如需无鉴权探针访问，还需在 `auth` 中间件白名单放行 `/api/healthz`、`/api/readyz`。

---

## 3. 日志位置与排查

日志目录由 `LOG_DIR` 控制，默认：
- `server/data/logs/app.log`
- `server/data/logs/error.log`

常用命令：
```bash
# 追踪错误
tail -f /mnt/d/Jason/Documents/Workspace/Project/Outlook-Mail-Manager/server/data/logs/error.log

# 查看最近健康检查记录
tail -n 200 /mnt/d/Jason/Documents/Workspace/Project/Outlook-Mail-Manager/server/data/logs/app.log | rg 'healthz|readyz'
```

---

## 4. 日志轮转建议

已提供示例：
- `scripts/logrotate.outlook-mail-manager.example`

建议策略：
- `daily` + `size 100M`
- `rotate 14`
- `compress`
- `copytruncate`（Node 进程无需重启）

---

## 5. 只读模式应急（基线流程）

> 当前仓库可能尚未完全实现 `READ_ONLY_MODE` 功能开关，本节定义操作基线。

### 触发条件
- SQLite 锁冲突频发（`database is locked`）
- 上游 Graph / IMAP 不稳定导致重试风暴
- 日志爆量接近磁盘阈值

### 临时处置步骤
1. 暂停批量任务入口（前端按钮下线/后端接口暂时返回 503）
2. 暂停 worker（若已拆分）
3. 保留查询能力，仅允许只读 API
4. 排查数据库写压力、日志量和上游状态
5. 恢复时先小批量灰度

---

## 6. 建议告警阈值（基线）

- `/api/readyz` 连续失败 >= 3 次（1 分钟）
- `error.log` 5 分钟内新增错误 >= 100 条
- 日志目录使用率 >= 80%
- SQLite 文件超过预警阈值（如 2GB）

---

## 7. 发布/回滚要点

发布前：
- 确认 `/api/healthz` 与 `/api/readyz` 可访问
- 检查日志目录权限
- 检查数据库路径可写

回滚时：
- 回滚服务代码
- 保留日志与数据库现场
- 复核 `LOG_DIR`、`DB_PATH` 配置
