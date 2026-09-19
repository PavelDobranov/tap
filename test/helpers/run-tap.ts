import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Exit code, or 128 + signal number when the process was killed. */
  code: number;
}

export const repoRoot = new URL("../../", import.meta.url);

const SIGNAL_NUMBERS: Record<string, number> = { SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };

/**
 * Runs a command and resolves with its outcome. Never rejects: a nonzero exit
 * is something to assert on, not an error. A signal death is reported as a
 * nonzero code so a crashed process can never be mistaken for success.
 */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd ?? fileURLToPath(repoRoot),
        env: { ...process.env, ...options.env },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr, code: exitCodeOf(error) });
      },
    );
  });
}

function exitCodeOf(error: (Error & { code?: unknown; signal?: unknown }) | null): number {
  if (error === null) return 0;
  if (typeof error.code === "number") return error.code;
  if (typeof error.signal === "string") return 128 + (SIGNAL_NUMBERS[error.signal] ?? 0);
  return 1;
}

/**
 * Runs the built `tap` executable — the one seam the test suite uses.
 */
export function runTap(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return run(fileURLToPath(new URL("dist/cli.js", repoRoot)), args, options);
}

export function readManifest(): {
  bin: Record<string, string>;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  scripts?: Record<string, string>;
} {
  return JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));
}

export interface SessionResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed by a signal. */
  code: number | null;
  /** Null when the process exited of its own accord. */
  signal: NodeJS.Signals | null;
}

/**
 * A `tap` process a test can watch and interrupt, for the commands that outlive
 * the agent and so cannot be waited on with `runTap`.
 */
export interface TapSession {
  stdout(): string;
  stderr(): string;
  /** Types a line at the agent, which inherits this process's stdin. */
  type(line: string): void;
  /** Ctrl+C: SIGINT to the whole process group, tap and agent alike. */
  interrupt(): void;
  /** Resolves once `pattern` has appeared in stdout; rejects on a timeout. */
  waitForOutput(pattern: RegExp): Promise<void>;
  /** Resolves once `pattern` has appeared in stderr; rejects on a timeout. */
  waitForError(pattern: RegExp): Promise<void>;
  exited: Promise<SessionResult>;
}

const WAIT_TIMEOUT_MS = 10_000;

/**
 * Starts the built `tap` executable in its own process group, so a test can
 * deliver SIGINT to the group the way a terminal delivers Ctrl+C to the
 * foreground one.
 */
export function startTap(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): TapSession {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("dist/cli.js", repoRoot)), ...args],
    {
      cwd: options.cwd ?? fileURLToPath(repoRoot),
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  const watchers = new Set<() => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    for (const notify of watchers) notify();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    for (const notify of watchers) notify();
  });

  const exited = new Promise<SessionResult>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });
  });

  return {
    stdout: () => stdout,
    stderr: () => stderr,
    type: (line) => child.stdin.write(`${line}\n`),
    interrupt: () => {
      try {
        process.kill(-child.pid!, "SIGINT");
      } catch {
        // Already gone; the assertions on `exited` say whether that was right.
      }
    },
    waitForOutput: (pattern) => waitFor(pattern, "stdout", () => stdout),
    waitForError: (pattern) => waitFor(pattern, "stderr", () => stderr),
    exited,
  };

  function waitFor(pattern: RegExp, stream: string, read: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!pattern.test(read())) return;
        done();
        resolve();
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for ${pattern} in ${stream}:\n${read()}`));
      }, WAIT_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        watchers.delete(check);
      };
      watchers.add(check);
      check();
    });
  }
}
