/**
 * The signals that end a frozen Tap session. SIGTERM is accepted alongside
 * SIGINT so that being shut down is as clean an exit as being interrupted.
 */
const INTERRUPTS = ["SIGINT", "SIGTERM"] as const satisfies readonly NodeJS.Signals[];

const ignore = (): void => {};

/**
 * Runs `body` with SIGINT ignored. Tap and the agent share a process group, so
 * Ctrl+C reaches both: ignoring it here leaves the agent to handle its own
 * interrupt and keeps Tap from exiting out from under it.
 */
export async function withSigintIgnored<T>(body: () => Promise<T>): Promise<T> {
  process.on("SIGINT", ignore);
  try {
    return await body();
  } finally {
    process.off("SIGINT", ignore);
  }
}

/**
 * Blocks until Tap is interrupted, then exits by re-raising the signal with
 * its default handling, so a Ctrl+C that ends Tap looks to the shell exactly
 * like a Ctrl+C that ends any other program. Never returns.
 *
 * A timer is held open for the duration: a process kept alive only by signal
 * handlers has an event loop Node considers drained, and Node says so on
 * stderr — output Tap has no business producing.
 */
export function exitOnInterrupt(): Promise<never> {
  return new Promise<never>(() => {
    const alive = setInterval(ignore, 1 << 30);
    for (const signal of INTERRUPTS) {
      process.on(signal, () => {
        clearInterval(alive);
        for (const other of INTERRUPTS) process.removeAllListeners(other);
        process.kill(process.pid, signal);
      });
    }
  });
}
