import { Context } from 'koa';
import fs from 'fs';
import path from 'path';
import db from '../database';
import { config } from '../config';
import { success } from '../utils/response';

type CheckStatus = 'ok' | 'fail';

interface ReadyChecks {
  database: {
    status: CheckStatus;
    detail: string;
  };
  logDirectory: {
    status: CheckStatus;
    path: string;
    detail: string;
  };
}

export class HealthController {
  async healthz(ctx: Context) {
    success(ctx, {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      pid: process.pid,
      node_env: config.nodeEnv,
    });
  }

  async readyz(ctx: Context) {
    const checks: ReadyChecks = {
      database: {
        status: 'ok',
        detail: 'query ok',
      },
      logDirectory: {
        status: 'ok',
        path: config.logDir,
        detail: 'write ok',
      },
    };

    let ready = true;

    try {
      db.prepare('SELECT 1 AS ok').get();
    } catch (error: any) {
      ready = false;
      checks.database = {
        status: 'fail',
        detail: error?.message || 'database check failed',
      };
    }

    try {
      fs.mkdirSync(config.logDir, { recursive: true });
      fs.accessSync(config.logDir, fs.constants.W_OK);

      const probePath = path.join(
        config.logDir,
        `.readyz-${process.pid}-${Date.now()}.tmp`
      );
      fs.writeFileSync(probePath, 'ok', 'utf8');
      fs.unlinkSync(probePath);
    } catch (error: any) {
      ready = false;
      checks.logDirectory = {
        status: 'fail',
        path: config.logDir,
        detail: error?.message || 'log directory write check failed',
      };
    }

    if (!ready) {
      ctx.status = 503;
    }

    success(ctx, {
      status: ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks,
      db_path: config.dbPath,
    });
  }
}
