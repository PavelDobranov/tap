import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A fake agent executable on its own `PATH` entry. Agents resolve by name
 * through `PATH`, so this is the real resolution path rather than a test-only
 * hook: shadowing `claude` with a script is how the suite gets a Claude Code
 * that does what a test needs.
 */
export interface FakeAgent {
  /** The directory to prepend to `PATH`. */
  readonly dir: string;
  /** The executable itself, for assertions that want the absolute path. */
  readonly executable: string;
  /** A `PATH` with this agent shadowing any real one, for a child's env. */
  readonly pathEnv: string;
  remove(): void;
}

/**
 * The default body: records the arguments it was given, announces itself, and
 * then stays interactive until stdin tells it to exit, so a test can observe a
 * running agent. `exit <code>` exits with that code; `echo <word>` writes a
 * line. Set `FAKE_AGENT_EXIT` to exit immediately instead.
 */
export const INTERACTIVE_AGENT = `
const { writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");

const argvFile = process.env.FAKE_AGENT_ARGV_FILE;
if (argvFile) writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));

process.stdout.write("agent: ready\\n");

const immediate = process.env.FAKE_AGENT_EXIT;
if (immediate !== undefined) process.exit(Number(immediate));

createInterface({ input: process.stdin }).on("line", (line) => {
  const [command, argument] = line.trim().split(/\\s+/);
  if (command === "exit") process.exit(Number(argument ?? "0"));
  if (command === "echo") process.stdout.write("agent: " + argument + "\\n");
});
`;

export function createFakeAgent(
  options: { name?: string; body?: string } = {},
): FakeAgent {
  const name = options.name ?? "claude";
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "tap-fake-agent-")), "bin");
  mkdirSync(dir, { recursive: true });

  const executable = path.join(dir, name);
  writeFileSync(executable, `#!/usr/bin/env node\n${options.body ?? INTERACTIVE_AGENT}`, {
    mode: 0o755,
  });

  return {
    dir,
    executable,
    pathEnv: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    remove: () => rmSync(path.dirname(dir), { recursive: true, force: true }),
  };
}
