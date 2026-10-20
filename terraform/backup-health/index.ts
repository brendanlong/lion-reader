// The Worker's entry point. Workers rejects a module whose named exports aren't
// handlers, so everything else lives in ./check.ts.

import { checkAndPing, type Env } from "./check";

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const worker = {
  scheduled(_controller: unknown, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(checkAndPing(env));
  },
};

export default worker;
