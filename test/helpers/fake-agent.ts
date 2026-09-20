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
 * running agent. `exit <code>` exits with that code; `signal <name>` kills it
 * with that signal, which is the only honest way to produce an agent that
 * exited by signal rather than by code; `echo <word>` writes a line. Set
 * `FAKE_AGENT_EXIT` to exit immediately instead.
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
  if (command === "signal") process.kill(process.pid, argument ?? "SIGTERM");
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

/**
 * One request the probe agent makes. Defaults are a plausible `/v1/messages`
 * POST, so a test only states the part it is asserting on.
 */
export interface ProbeStep {
  readonly method?: string;
  readonly path?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

/** A chunk as the agent received it, timed from the arrival of the first one. */
export interface ProbeChunk {
  readonly atMs: number;
  readonly text: string;
}

/** What one scripted request got back. */
export interface ProbeResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly chunks: ProbeChunk[];
  /** Every chunk joined: the response body as bytes. */
  readonly body: string;
  /** Set instead of the rest when the request itself failed. */
  readonly error?: string;
}

/** The file the probe agent writes: the agent's side of the whole exchange. */
export interface ProbeTranscript {
  /** The base URL the agent was pointed at — Tap's proxy, in a real session. */
  readonly baseUrl: string;
  readonly responses: ProbeResponse[];
}

/**
 * The assertion probe: an agent that issues scripted requests at whatever
 * `ANTHROPIC_BASE_URL` names and writes down what came back, chunk by chunk
 * and with arrival times. Streaming fidelity is asserted from this file, at
 * the CLI seam, with no hook inside Tap.
 *
 * Reads `FAKE_AGENT_PROBE_SCRIPT` (a JSON array of steps) and writes
 * `FAKE_AGENT_PROBE_FILE`, then exits — or, with `FAKE_AGENT_PROBE_STAY` set,
 * waits for `exit` on stdin, so a test can inspect a session still running.
 * With `FAKE_AGENT_PROBE_CONCURRENTLY` set the steps all go at once, which is
 * how a test gets requests overlapping on the wire; the transcript is then in
 * completion order rather than script order.
 */
export const PROBE_AGENT = `
const { writeFileSync } = require("node:fs");
const http = require("node:http");

const base = new URL(process.env.ANTHROPIC_BASE_URL);
const script = JSON.parse(process.env.FAKE_AGENT_PROBE_SCRIPT || "[{}]");
const transcript = { baseUrl: base.toString(), responses: [] };

function ask(step) {
  return new Promise((resolve) => {
    // Collected out here so a response that is cut off still reports what it
    // received before the connection went away.
    const chunks = [];
    let answered;
    let first;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      transcript.responses.push({
        status: answered ? answered.statusCode : 0,
        headers: answered ? answered.headers : {},
        chunks,
        body: chunks.map((chunk) => chunk.text).join(""),
        ...(error === undefined ? {} : { error }),
      });
      resolve();
    };
    const path = step.path || "/v1/messages";
    const body = step.body === undefined ? '{"model":"claude-opus-5"}' : step.body;
    const request = http.request(
      {
        host: base.hostname,
        port: base.port,
        method: step.method || "POST",
        path: base.pathname.replace(/\\/$/, "") + path,
        headers: Object.assign(
          { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
          step.headers || {},
        ),
      },
      (response) => {
        response.socket.setNoDelay(true);
        answered = response;
        response.on("data", (chunk) => {
          const now = process.hrtime.bigint();
          if (first === undefined) first = now;
          chunks.push({ atMs: Number(now - first) / 1e6, text: chunk.toString("utf8") });
        });
        response.on("end", () => finish());
        // A response the upstream cut off never ends; what arrived before the
        // connection went away is still what the agent saw.
        response.on("close", () => {
          if (!response.complete) finish("the response was cut off");
        });
      },
    );
    request.on("socket", (socket) => socket.setNoDelay(true));
    request.on("error", (error) => finish(String(error.message)));
    request.end(body);
  });
}

(async () => {
  // In flight together, rather than one after another, when the test is about
  // what Tap does with requests that overlap.
  if (process.env.FAKE_AGENT_PROBE_CONCURRENTLY) await Promise.all(script.map(ask));
  else for (const step of script) await ask(step);
  writeFileSync(process.env.FAKE_AGENT_PROBE_FILE, JSON.stringify(transcript));
  if (!process.env.FAKE_AGENT_PROBE_STAY) process.exit(Number(process.env.FAKE_AGENT_EXIT || "0"));
  require("node:readline")
    .createInterface({ input: process.stdin })
    .on("line", (line) => {
      if (line.trim() === "exit") process.exit(Number(process.env.FAKE_AGENT_EXIT || "0"));
    });
})();
`;
