import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface TapResult {
  stdout: string;
  stderr: string;
  code: number;
}

const binary = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

/**
 * Runs the built `tap` executable as a subprocess — the one seam the test
 * suite uses. Never rejects: a nonzero exit is an outcome to assert on, not
 * an error.
 */
export function runTap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<TapResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { env: { ...process.env, ...env }, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code: error && typeof error.code === "number" ? error.code : 0,
        });
      },
    );
  });
}
