import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createFakeAgent } from "./helpers/fake-agent.ts";
import { runTap, startTap, type TapSessionResult, type TapSession } from "./helpers/run-tap.ts";

const agent = createFakeAgent();
after(() => agent.remove());

const scratch = mkdtempSync(path.join(tmpdir(), "tap-launch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let argvFiles = 0;
/** A file the fake agent writes its arguments to, one per test. */
function argvFile(): { path: string; read: () => string[] } {
  const file = path.join(scratch, `argv-${argvFiles++}.json`);
  return { path: file, read: () => JSON.parse(readFileSync(file, "utf8")) };
}

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: agent.pathEnv, ...extra };
}

/** Waits for the session to freeze, then quits it the way a user would. */
async function quitFrozenSession(session: TapSession): Promise<TapSessionResult> {
  await session.waitForError(/frozen/);
  session.interrupt();
  return session.exited;
}

test("launch claude runs the agent with no arguments of Tap's own", async () => {
  const argv = argvFile();
  const session = startTap(["launch", "claude"], {
    env: env({ FAKE_AGENT_ARGV_FILE: argv.path, FAKE_AGENT_EXIT: "0" }),
  });

  await quitFrozenSession(session);

  assert.deepEqual(argv.read(), []);
});

test("arguments after the agent name are forwarded verbatim", async () => {
  const argv = argvFile();
  const session = startTap(["launch", "claude", "--model", "opus", "--resume"], {
    env: env({ FAKE_AGENT_ARGV_FILE: argv.path, FAKE_AGENT_EXIT: "0" }),
  });

  await quitFrozenSession(session);

  assert.deepEqual(argv.read(), ["--model", "opus", "--resume"]);
});

test("launch with no agent named runs claude, forwarding its arguments", async () => {
  const argv = argvFile();
  const session = startTap(["launch", "--model", "opus"], {
    env: env({ FAKE_AGENT_ARGV_FILE: argv.path, FAKE_AGENT_EXIT: "0" }),
  });

  await quitFrozenSession(session);

  assert.deepEqual(argv.read(), ["--model", "opus"]);
});

test("an unknown agent name exits nonzero naming the agent Tap knows", async () => {
  const result = await runTap(["launch", "gemini"], { env: env() });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /^tap: unknown agent: gemini/m);
  assert.match(result.stderr, /\bclaude\b/);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "should not print a stack trace");
  assert.equal(result.stdout, "");
});

test("an agent that is not on PATH exits nonzero with a clear message", async () => {
  // Node stays on PATH — tap's own shebang needs it — but no agent does.
  const result = await runTap(["launch", "claude"], {
    env: { PATH: path.dirname(process.execPath) },
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /^tap: claude was not found on PATH/m);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "should not print a stack trace");
});

test("Tap writes nothing to the terminal while the agent is running", async () => {
  const session = startTap(["launch", "claude"], { env: env() });

  await session.waitForOutput(/agent: ready/);
  session.type("echo hello");
  await session.waitForOutput(/agent: hello/);

  assert.equal(session.stdout(), "agent: ready\nagent: hello\n");
  assert.equal(session.stderr(), "", "tap must not speak over the agent");

  session.type("exit 0");
  await quitFrozenSession(session);
});

test("Ctrl+C interrupts the agent while Tap stays up, and a second one ends Tap", async () => {
  const session = startTap(["launch", "claude"], { env: env() });
  await session.waitForOutput(/agent: ready/);

  session.interrupt();
  await session.waitForError(/terminated by SIGINT/);
  assert.equal(session.stdout(), "agent: ready\n", "the agent, not Tap, handled Ctrl+C");

  session.interrupt();
  const result = await session.exited;

  assert.equal(result.signal, "SIGINT");
});

test("an agent's exit code is reported, and is distinguishable from a signal", async () => {
  const session = startTap(["launch", "claude"], {
    env: env({ FAKE_AGENT_EXIT: "3" }),
  });

  const result = await quitFrozenSession(session);

  assert.match(result.stderr, /^tap: claude exited with code 3$/m);
  assert.doesNotMatch(result.stderr, /SIG/);
});

test("concurrent sessions do not interfere with one another", async () => {
  const first = argvFile();
  const second = argvFile();
  const sessions = [
    startTap(["launch", "claude", "--first"], {
      env: env({ FAKE_AGENT_ARGV_FILE: first.path }),
    }),
    startTap(["launch", "claude", "--second"], {
      env: env({ FAKE_AGENT_ARGV_FILE: second.path }),
    }),
  ];
  await Promise.all(sessions.map((session) => session.waitForOutput(/agent: ready/)));

  // Quitting one must leave the other running and unchanged.
  sessions[0]!.type("exit 7");
  const quit = await quitFrozenSession(sessions[0]!);
  assert.match(quit.stderr, /exited with code 7/);
  assert.equal(sessions[1]!.stderr(), "");

  sessions[1]!.type("exit 0");
  const survivor = await quitFrozenSession(sessions[1]!);

  assert.match(survivor.stderr, /exited with code 0/);
  assert.deepEqual(first.read(), ["--first"]);
  assert.deepEqual(second.read(), ["--second"]);
});
