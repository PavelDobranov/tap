import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentExit } from "../../src/agent/run.ts";

/**
 * What a process the suite ran left behind: its output, and how it ended.
 *
 * The end is `AgentExit` itself rather than a restatement of it. Most of what
 * the suite runs is Tap or the fake agent, the assertions are about the exits
 * Tap produces and reports, and a suite that spelled those a second way could
 * go on passing while the spelling Tap uses changed under it.
 */
export interface RunResult extends AgentExit {
  stdout: string;
  stderr: string;
}

export const repoRoot = new URL("../../", import.meta.url);

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
 * Runs a command and resolves with how it ended. Never rejects: a nonzero exit
 * is something to assert on, not an error. A signal death is reported as a
 * signal, not as `128 + n`: a test that wants to know a process was killed
 * should not have to read it out of an exit code Tap itself never produces.
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
        resolve({ stdout, stderr, ...exitOf(error) });
      },
    );
  });
}

/** `execFile`'s error, read back as the exit it stands for. */
function exitOf(error: (Error & { code?: unknown; signal?: unknown }) | null): AgentExit {
  if (error === null) return { code: 0, signal: null };
  if (typeof error.signal === "string") {
    return { code: null, signal: error.signal as NodeJS.Signals };
  }
  if (typeof error.code === "number") return { code: error.code, signal: null };
  // Neither, so nothing ran to an exit: the command was not found, or could
  // not be spawned, and `code` is an errno string. A timeout does not land
  // here — `execFile` kills the child, which arrives as the signal above.
  return { code: 1, signal: null };
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
 * Runs the built `tap` executable — the seam for everything whose subject is
 * the process: the terminal, signals, `PATH`, the configurations Tap refuses,
 * exit codes and packaging. Anything whose subject is the record or the viewer
 * goes through the other seam and starts Tap's modules in-process. See
 * ADR-0009 for the line between them.
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
  exited: Promise<RunResult>;
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

  const exited = new Promise<RunResult>((resolve) => {
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
