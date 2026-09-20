import { spawn } from "node:child_process";
import type { Invocation } from "./claude.ts";

/**
 * How the agent ended: the one definition, used by the agent layer that
 * produces it, the record that freezes on it, and the tests that assert on it.
 *
 * Exit code and signal are kept apart, and exactly one of them is ever set,
 * because a signal death is a normal end to an interactive session rather than
 * a failure. Collapsing the two — a signal reported as `128 + n` — throws away
 * the distinction the record keeps deliberately, so nothing here does it.
 */
export interface AgentExit {
  /** Null when the agent was killed by a signal. */
  readonly code: number | null;
  /** Null when the agent exited of its own accord. */
  readonly signal: NodeJS.Signals | null;
}

/** An agent that could not be started, as opposed to one that ran and failed. */
export class AgentNotFoundError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`${command} was not found on PATH`);
    this.name = "AgentNotFoundError";
    this.command = command;
  }
}

/**
 * Runs an agent to completion on this terminal, with `overrides` added to the
 * environment it inherits — which is how the agent is pointed at Tap's proxy.
 *
 * Stdio is inherited, so the agent has the real terminal: colours, raw mode,
 * keyboard input and resize all work with no relaying and, decisively, no PTY
 * — a native dependency Tap has no use for. Tap writes nothing while the agent
 * runs, so its output can never interleave with the agent's.
 */
export function runAgent(
  invocation: Invocation,
  overrides: NodeJS.ProcessEnv = {},
): Promise<AgentExit> {
  return new Promise<AgentExit>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env: { ...process.env, ...overrides },
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT" ? new AgentNotFoundError(invocation.command) : error,
      );
    });
    child.on("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
}
