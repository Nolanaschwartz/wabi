import { type LogLevel, type LoggerService } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

const STORAGE = new AsyncLocalStorage<string>();

function getLogLevel(): LogLevel[] {
  const level = (process.env.LOG_LEVEL ?? 'log').toLowerCase();
  const levels: LogLevel[] = [];
  const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error'];
  const idx = order.indexOf(level as LogLevel);
  if (idx >= 0) {
    for (let i = idx; i < order.length; i++) levels.push(order[i]);
  }
  return levels;
}

export function getTraceId(): string | undefined {
  return STORAGE.getStore();
}

export function withTraceId<T>(traceId: string, fn: () => T): T {
  return STORAGE.run(traceId, fn);
}

function formatJson(
  level: string,
  context: string,
  message: string,
  traceId?: string,
  metadata?: Record<string, unknown>,
): string {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    lvl: level,
    ctx: context,
    msg: message,
  };
  if (traceId) entry['tid'] = traceId;
  if (metadata) Object.assign(entry, metadata);
  return JSON.stringify(entry);
}

export class JsonLogger implements LoggerService {
  private readonly _levels: LogLevel[];
  private _context: string;

  constructor(context: string = 'JsonLogger', levels?: LogLevel[]) {
    this._context = context;
    this._levels = levels ?? getLogLevel();
  }

  private emit(level: string, message: string, metadata: Record<string, unknown> | undefined): void {
    if (!this._levels.includes(level as LogLevel)) return;
    const tid = getTraceId();
    const json = formatJson(level, this._context, message, tid, metadata);
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(json);
  }

  private parseArgs(
    args: any[],
  ): { message: string; metadata: Record<string, unknown> | undefined } {
    const first = args[0];
    const message = typeof first === 'string' ? first : String(first ?? '');
    const second = args[1];

    if (second === undefined || second === null) {
      return { message, metadata: undefined };
    }

    // String context: logger.log('msg', 'SomeContext') — treat as metadata
    if (typeof second === 'string') {
      return { message, metadata: { _ctx: second } };
    }

    // Error stack: logger.error('msg', err.stack) — treat as metadata
    if (second instanceof Error) {
      return { message, metadata: { error: second.message, stack: second.stack } };
    }

    // Object metadata: logger.log('msg', { userId: '123' })
    if (typeof second === 'object' && !Array.isArray(second)) {
      return { message, metadata: second as Record<string, unknown> };
    }

    return { message, metadata: undefined };
  }

  log(message: string, ...optionalParams: any[]): void {
    const { message: msg, metadata } = this.parseArgs([message, ...optionalParams]);
    this.emit('log', msg, metadata);
  }

  warn(message: string, ...optionalParams: any[]): void {
    const { message: msg, metadata } = this.parseArgs([message, ...optionalParams]);
    this.emit('warn', msg, metadata);
  }

  error(message: string, ...optionalParams: any[]): void {
    const { message: msg, metadata } = this.parseArgs([message, ...optionalParams]);
    this.emit('error', msg, metadata);
  }

  debug(message: string, ...optionalParams: any[]): void {
    const { message: msg, metadata } = this.parseArgs([message, ...optionalParams]);
    this.emit('debug', msg, metadata);
  }

  verbose(message: string, ...optionalParams: any[]): void {
    const { message: msg, metadata } = this.parseArgs([message, ...optionalParams]);
    this.emit('verbose', msg, metadata);
  }
}
