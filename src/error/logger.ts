/**
 * Injectable logger.
 *
 * Structured logging with connection/user/tenant/room context; never raw
 * credentials or full payloads by default. All modules that perform logging
 * should depend on this interface so the logger can be swapped for tests or
 * production observability backends.
 */
export interface Logger {
  debug?(payload: unknown, message?: string): void;
  info?(payload: unknown, message?: string): void;
  warn?(payload: unknown, message?: string): void;
  error?(payload: unknown, message?: string): void;
}

export class ConsoleLogger implements Logger {
  debug(payload: unknown, message?: string): void {
    console.debug(message ?? "", payload);
  }
  info(payload: unknown, message?: string): void {
    console.info(message ?? "", payload);
  }
  warn(payload: unknown, message?: string): void {
    console.warn(message ?? "", payload);
  }
  error(payload: unknown, message?: string): void {
    console.error(message ?? "", payload);
  }
}

export class SilentLogger implements Logger {}
