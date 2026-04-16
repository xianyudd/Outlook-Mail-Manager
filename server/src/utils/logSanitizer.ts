const REDACTED = '[REDACTED]';

export const SENSITIVE_KEY_PATTERNS = [
  'refresh_token',
  'access_token',
  'id_token',
  'token',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'proxy_authorization',
  'cookie',
  'set_cookie',
  'client_secret',
  'secret',
  'api_key',
  'x_api_key',
  'xoauth2',
] as const;

const SENSITIVE_STRING_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\b(Bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: '$1 [REDACTED]' },
  { pattern: /\b(Basic)\s+[A-Za-z0-9+/=]+/gi, replacement: '$1 [REDACTED]' },
  {
    pattern: /((?:refresh|access|id)_token\s*[=:]\s*)([^\s,;]+)/gi,
    replacement: '$1[REDACTED]',
  },
  { pattern: /(client_secret\s*[=:]\s*)([^\s,;]+)/gi, replacement: '$1[REDACTED]' },
  { pattern: /(password\s*[=:]\s*)([^\s,;]+)/gi, replacement: '$1[REDACTED]' },
  { pattern: /(authorization\s*[=:]\s*)([^\s,;]+)/gi, replacement: '$1[REDACTED]' },
  { pattern: /(cookie\s*[=:]\s*)([^\n;]+)/gi, replacement: '$1[REDACTED]' },
];

const MAX_DEPTH = 8;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_PATTERNS.some((pattern) => normalized.includes(normalizeKey(pattern)));
}

function sanitizeString(value: string): string {
  let sanitized = value;

  for (const { pattern, replacement } of SENSITIVE_STRING_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }

  if (sanitized.includes('----')) {
    const parts = sanitized.split('----');
    if (parts.length >= 4 && parts[0].includes('@')) {
      parts[1] = REDACTED;
      parts[3] = REDACTED;
      sanitized = parts.join('----');
    }
  }

  return sanitized;
}

function sanitizeError(error: Error, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    name: error.name,
    message: sanitizeString(error.message),
  };

  const maybeCode = (error as { code?: unknown }).code;
  if (maybeCode !== undefined) {
    sanitized.code = sanitizeValue(maybeCode, seen, depth - 1);
  }

  if (error.stack) {
    sanitized.stack = sanitizeString(error.stack);
  }

  return sanitized;
}

function sanitizeObject(
  input: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number
): Record<string, unknown> {
  if (depth <= 0) {
    return { value: '[MaxDepthExceeded]' };
  }

  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = sanitizeValue(value, seen, depth - 1);
  }

  return output;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'symbol') {
    return value.toString();
  }

  if (typeof value === 'function') {
    return `[Function ${(value as Function).name || 'anonymous'}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer length=${value.length}]`;
  }

  if (value instanceof Error) {
    return sanitizeError(value, seen, depth);
  }

  if (typeof value === 'object') {
    const objectValue = value as object;
    if (seen.has(objectValue)) {
      return '[Circular]';
    }

    seen.add(objectValue);
    const result = Array.isArray(value)
      ? value.map((item) => sanitizeValue(item, seen, depth - 1))
      : sanitizeObject(value as Record<string, unknown>, seen, depth);
    seen.delete(objectValue);

    return result;
  }

  return value;
}

export function sanitizeForLog<T>(input: T): T {
  return sanitizeValue(input, new WeakSet<object>(), MAX_DEPTH) as T;
}

export { REDACTED };
