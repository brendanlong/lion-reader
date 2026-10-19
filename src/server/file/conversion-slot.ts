/**
 * Runs memory-heavy document conversions one at a time per process, so their
 * peaks never overlap on a 512MB VM. Each converter owns a slot.
 */

import { errors } from "@/server/errors";

/** The deadline passed before the conversion got the slot: load, not the file. */
export class QueueTimeoutError extends Error {
  constructor(work: string) {
    super(`${work} timed out waiting for its turn`);
    this.name = "QueueTimeoutError";
  }
}

export interface ConversionSlot {
  /**
   * Waits for the slot, giving up at `deadline` (epoch ms).
   *
   * @throws `SERVER_BUSY` if `maxQueued` conversions are already waiting
   * @throws {@link QueueTimeoutError} if the deadline passes first
   */
  acquire(deadline: number): Promise<void>;
  release(): void;
}

/**
 * @param maxQueued - Conversions allowed to wait behind the running one. Each
 *   waiter holds its upload in memory, and one past a handful would likely
 *   miss its deadline anyway.
 * @param work - Plural noun for error messages ("document conversions").
 */
export function createConversionSlot(maxQueued: number, work: string): ConversionSlot {
  let busy = false;
  const waiting: Array<() => void> = [];

  function acquire(deadline: number): Promise<void> {
    if (!busy) {
      busy = true;
      return Promise.resolve();
    }
    if (waiting.length >= maxQueued) {
      return Promise.reject(errors.serverBusy(work));
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(grant), 1);
        reject(new QueueTimeoutError(work));
      }, deadline - Date.now());
      waiting.push(grant);
    });
  }

  function release(): void {
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      busy = false;
    }
  }

  return { acquire, release };
}
