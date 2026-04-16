import fs from 'fs';
import path from 'path';
import winston from 'winston';
import { config } from '../config';
import { sanitizeForLog } from './logSanitizer';

if (!fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

const sanitizeFormat = winston.format((info) => {
  return sanitizeForLog(info as Record<string, unknown>) as winston.Logform.TransformableInfo;
});

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  sanitizeFormat(),
  winston.format.json()
);

const effectiveLogLevel =
  config.logLevel === 'debug' && !config.featureFlags.DEBUG_LOG_ENABLED ? 'info' : config.logLevel;

const logger = winston.createLogger({
  level: effectiveLogLevel,
  format: jsonFormat,
  defaultMeta: {
    service: 'outlook-mail-manager-server',
    env: config.nodeEnv,
  },
  transports: [
    new winston.transports.Console({ format: jsonFormat }),
    new winston.transports.File({ filename: path.join(config.logDir, 'app.log') }),
    new winston.transports.File({ filename: path.join(config.logDir, 'error.log'), level: 'error' }),
  ],
});

export default logger;
