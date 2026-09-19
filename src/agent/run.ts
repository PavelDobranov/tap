import { spawn } from "node:child_process";
import type { Invocation } from "./claude.ts";

/**
 * How an agent process ended. Exit code and signal are kept apart because a
 * signal death is a normal end to an interactive session, not a failure, and
 * the distinction has to stay legible to whatever reads the record.
 */
export interface AgentOutcome {
  /** Null when the agent was killed by a signal. */
  readonly code: number | null;
  /** Null when the agent exited of its own accord. */
  readonly signal: NodeJS.Signals | null;
}

/** How an agent's end reads to a human. */
export function describeOutcome(command: string, outcome: AgentOutcome): string {
  if (outcome.signal !== null) return `${command} was terminated by ${outcome.signal}`;
  return `${command} exited with code ${outcome.code ?? 0}`;
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
 * Runs an agent to completion on this terminal.
 *
 * Stdio is inherited, so the agent has the real terminal: colours, raw mode,
 * keyboard input and resize all work with no relaying and, decisively, no PTY
 * — a native dependency Tap has no use for. Tap writes nothing while the agent
 * runs, so its output can never interleave with the agent's.
 */
export function runAgent(invocation: Invocation): Promise<AgentOutcome> {
  return new Promise<AgentOutcome>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { stdio: "inherit" });

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
