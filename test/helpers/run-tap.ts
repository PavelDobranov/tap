import { execFile } from "node:child_process";
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
export function runTap(args: string[]): Promise<RunResult> {
  return run(fileURLToPath(new URL("dist/cli.js", repoRoot)), args);
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
