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
 * The environment a `tap` under test is started in: this process's, minus the
 * variables Tap reads, plus whatever the test asked for.
 *
 * Those are dropped because whoever runs the suite may be behind a gateway or
 * configured for a cloud provider, and inheriting either would point Tap
 * somewhere the test did not choose or refuse the launch outright. A test that
 * wants one says so.
 */
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name !== "ANTHROPIC_BASE_URL" && !name.startsWith("CLAUDE_CODE_USE_"),
    ),
  );
  return { ...inherited, ...extra };
}

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
        env: childEnv(options.env),
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
 * `tap launch` on a UI port of its own. Sessions run concurrently across the
 * suite, and the UI's default port is fixed by design, so every test but the
 * one asserting that default names a port — which is what `--port` is for.
 */
export async function runLaunch(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return runTap(["launch", "--port", String(await freePort()), ...args], options);
}

/** The same, for a session a test needs to watch rather than wait on. */
export async function startLaunch(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TapSession> {
  return startTap(["launch", "--port", String(await freePort()), ...args], options);
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

export interface TapSessionResult {
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
  /** Ends the session outright, for a test that has already failed. */
  kill(): void;
  /** Resolves once `pattern` has appeared in stdout; rejects on a timeout. */
  waitForOutput(pattern: RegExp): Promise<void>;
  /** Resolves once `pattern` has appeared in stderr; rejects on a timeout. */
  waitForError(pattern: RegExp): Promise<void>;
  exited: Promise<TapSessionResult>;
}

const WAIT_TIMEOUT_MS = 10_000;

/**
 * Starts the built `tap` executable in its own process group, so a test can
 * deliver SIGINT to the group the way a terminal delivers Ctrl+C to the
 * foreground one.
 */
/**
 * Every session this file has started. A `tap` session outlives its agent by
 * design, so an assertion that fails before the test quits its session would
 * otherwise leave one running and the suite waiting on it forever.
 */
const started = new Set<TapSession>();

/** Ends every session left behind. Call from an `after` hook in each file. */
export function killAllSessions(): void {
  for (const session of started) session.kill();
  started.clear();
}

export function startTap(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): TapSession {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("dist/cli.js", repoRoot)), ...args],
    {
      cwd: options.cwd ?? fileURLToPath(repoRoot),
      env: childEnv(options.env),
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

  const exited = new Promise<TapSessionResult>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });
  });

  const signal = (which: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, which);
    } catch {
      // Already gone; the assertions on `exited` say whether that was right.
    }
  };

  const session: TapSession = {
    stdout: () => stdout,
    stderr: () => stderr,
    type: (line) => child.stdin.write(`${line}\n`),
    interrupt: () => signal("SIGINT"),
    kill: () => signal("SIGKILL"),
    waitForOutput: (pattern) => waitFor(pattern, "stdout", () => stdout),
    waitForError: (pattern) => waitFor(pattern, "stderr", () => stderr),
    exited,
  };
  started.add(session);
  void exited.then(() => started.delete(session));
  return session;

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

/**
 * A loopback port nothing is listening on, for the tests that need to know the
 * UI's address before Tap prints it. Bound and released rather than guessed, so
 * a busy machine does not make the suite flaky.
 */
export async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
