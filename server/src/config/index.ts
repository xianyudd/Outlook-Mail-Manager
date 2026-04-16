import dotenv from 'dotenv';
import path from 'path';

// 尝试加载根目录和 server 目录的 .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

export type FeatureFlags = {
  MAIL_FETCH_ENABLED: boolean;
  MAIL_CLEAR_REMOTE_ENABLED: boolean;
  BULK_PULL_ENABLED: boolean;
  READ_ONLY_MODE: boolean;
  DEBUG_LOG_ENABLED: boolean;
};

export type AppConfig = {
  port: number;
  logLevel: string;
  logDir: string;
  dbPath: string;
  accessPassword: string;
  nodeEnv: string;
  featureFlags: FeatureFlags;
};

export const config: AppConfig = {
  port: parseNumber(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL || 'info',
  logDir: path.resolve(__dirname, '../..', process.env.LOG_DIR || './data/logs'),
  dbPath: path.resolve(__dirname, '../..', process.env.DB_PATH || './data/outlook.db'),
  accessPassword: process.env.ACCESS_PASSWORD || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  featureFlags: {
    MAIL_FETCH_ENABLED: parseBoolean(process.env.MAIL_FETCH_ENABLED, true),
    MAIL_CLEAR_REMOTE_ENABLED: parseBoolean(process.env.MAIL_CLEAR_REMOTE_ENABLED, false),
    BULK_PULL_ENABLED: parseBoolean(process.env.BULK_PULL_ENABLED, true),
    READ_ONLY_MODE: parseBoolean(process.env.READ_ONLY_MODE, false),
    DEBUG_LOG_ENABLED: parseBoolean(process.env.DEBUG_LOG_ENABLED, false),
  },
};
