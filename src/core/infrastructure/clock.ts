/**
 * Injectable clock. Tests control time through a fake clock so heartbeat
 * deadlines and auth timeouts are deterministic without wall-clock sleeps.
 */
export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}
