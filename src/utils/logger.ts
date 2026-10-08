// Logger Utility
// Provides structured logging using winston

import winston from 'winston';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'json' | 'simple';

/**
 * Safely serialize an object to avoid circular references
 */
function safeStringify(obj: any): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular Reference]';
      }
      seen.add(value);
    }
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack
      };
    }
    return value;
  });
}

// Recent warnings and errors, kept in memory for the admin console's log view
// and diagnostics export (newest last, bounded). Fields whose names look like
// credentials are redacted; values are clipped.
export interface LogRecord { at: string; level: 'error' | 'warn'; message: string; meta: string | null }
const RECENT_MAX = 500;
const recent: LogRecord[] = [];
const SECRET_KEY = /secret|password|passwd|token|authorization|cookie|apikey|api_key|integrationcode/i;

function redactedMeta(meta: unknown): string | null {
  if (meta === undefined || meta === null) return null;
  try {
    const seen = new WeakSet();
    const out = JSON.stringify(meta, (key, value) => {
      if (key && SECRET_KEY.test(key)) return '[redacted]';
      if (value instanceof Error) return { name: value.name, message: value.message };
      if (typeof value === 'object' && value !== null) { if (seen.has(value)) return '[Circular]'; seen.add(value); }
      return value;
    });
    return out && out.length > 1000 ? `${out.slice(0, 1000)}…` : out ?? null;
  } catch { return null; }
}

function remember(level: 'error' | 'warn', message: string, meta: unknown): void {
  recent.push({ at: new Date().toISOString(), level, message: message.length > 1000 ? `${message.slice(0, 1000)}…` : message, meta: redactedMeta(meta) });
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX);
}

/** Recent warnings/errors, newest first. */
export function recentLogs(limit = RECENT_MAX): LogRecord[] { return recent.slice(-Math.max(1, Math.min(limit, RECENT_MAX))).reverse(); }

/** Tests only. */
export function _resetRecentLogs(): void { recent.length = 0; }

export class Logger {
  private winston: winston.Logger;

  constructor(level: LogLevel = 'info', format: LogFormat = 'json') {
    this.winston = winston.createLogger({
      level,
      format: format === 'json' 
        ? winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const logObject = {
                level,
                message,
                timestamp,
                ...meta
              };
              return safeStringify(logObject);
            })
          )
        : winston.format.combine(
            winston.format.timestamp(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const metaStr = Object.keys(meta).length > 0 ? ` ${safeStringify(meta)}` : '';
              return `${timestamp} [${level.toUpperCase()}]: ${message}${metaStr}`;
            })
          ),
      transports: [
        new winston.transports.Console({
          // MCP stdio transport uses stdout for JSON-RPC messages.
          // All log output must go to stderr to avoid corrupting the channel.
          stderrLevels: ['error', 'warn', 'info', 'debug']
        })
      ]
    });
  }

  error(message: string, meta?: any): void {
    remember('error', message, meta);
    this.winston.error(message, meta);
  }

  warn(message: string, meta?: any): void {
    remember('warn', message, meta);
    this.winston.warn(message, meta);
  }

  info(message: string, meta?: any): void {
    this.winston.info(message, meta);
  }

  debug(message: string, meta?: any): void {
    this.winston.debug(message, meta);
  }

  setLevel(level: LogLevel): void {
    this.winston.level = level;
  }
} 