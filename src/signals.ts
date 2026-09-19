/**
 * The signals that end a frozen Tap session. SIGTERM is accepted alongside
 * SIGINT so that being shut down is as clean an exit as being interrupted.
 */
const INTERRUPTS = ["SIGINT", "SIGTERM"] as const satisfies readonly NodeJS.Signals[];

const noop = (): void => {};

/**
 * Stops SIGINT from killing Tap. Tap and the agent share a process group, so
 * Ctrl+C reaches both: ignoring it here leaves the agent to handle its own
 * interrupt and keeps Tap from exiting out from under it.
 */
export function ignoreSigint(): void {
  process.on("SIGINT", noop);
}

/** Gives SIGINT back its default handling. */
export function restoreSigint(): void {
  process.off("SIGINT", noop);
}

/**
 * Blocks until Tap is interrupted, then exits by re-raising the signal with
 * its default handling, so a Ctrl+C that ends Tap looks to the shell exactly
 * like a Ctrl+C that ends any other program. Never returns.
 *
 * Taking over from `ignoreSigint` is done in this order — listen, then stop
 * ignoring — because the reverse leaves a window in which a Ctrl+C aimed at
 * the agent would kill Tap instead of freezing the session.
 *
 * A timer is held open for the duration: a process kept alive only by signal
 * handlers has an event loop Node considers drained, and Node says so on
 * stderr — output Tap has no business producing.
 */
export function exitOnInterrupt(): Promise<never> {
  return new Promise<never>(() => {
    const alive = setInterval(noop, 1 << 30);
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of INTERRUPTS) {
      const handler = (): void => {
        clearInterval(alive);
        for (const [other, installed] of handlers) process.off(other, installed);
        process.kill(process.pid, signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    restoreSigint();
  });
}
