import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A fake `claude` executable on its own `PATH` entry. Agents resolve by name
 * through `PATH`, so this is the real resolution path rather than a test-only
 * hook: shadowing `claude` with a script is how the suite gets a Claude Code
 * that does what a test needs.
 */
export interface FakeAgent {
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

/** Writes a fake `claude`, whose body a caller may replace wholesale. */
export function createFakeAgent(body: string = INTERACTIVE_AGENT): FakeAgent {
  const root = mkdtempSync(path.join(tmpdir(), "tap-fake-agent-"));
  const dir = path.join(root, "bin");
  mkdirSync(dir, { recursive: true });

  writeFileSync(path.join(dir, "claude"), `#!/usr/bin/env node\n${body}`, {
    mode: 0o755,
  });

  return {
    pathEnv: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
