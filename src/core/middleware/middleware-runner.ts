/**
 * Middleware runner.
 *
 * Middleware runs around inbound actions such as `room:join`,
 * `room:leave`, `document:subscribe`, and `event:publish`. A middleware
 * `next()` must not be callable more than once.
 */
export type MiddlewareNext = () => Promise<void>;

export interface MiddlewareContext {
  action: "room:join" | "room:leave" | "document:subscribe" | "document:unsubscribe" | "event:publish";
  connectionId: string;
  payload?: unknown;
}

export interface Middleware {
  (context: MiddlewareContext, next: MiddlewareNext): Promise<void> | void;
}

export class MiddlewareRunner {
  private readonly middleware: Middleware[] = [];

  use(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  async run(context: MiddlewareContext, handler: () => Promise<void>): Promise<void> {
    let index = 0;
    let called = false;

    const next: MiddlewareNext = async () => {
      if (called) {
        throw new Error("middleware next() called more than once");
      }
      called = true;
      index += 1;
      await this.runLayer(index, context, handler);
    };

    await this.runLayer(0, context, handler, next);
  }

  private async runLayer(
    i: number,
    context: MiddlewareContext,
    handler: () => Promise<void>,
    next?: MiddlewareNext
  ): Promise<void> {
    const mw = this.middleware[i];
    if (!mw) {
      await handler();
      return;
    }

    const result = mw(context, next ?? handler);
    if (result && typeof result.then === "function") {
      await result;
    }
  }
}
