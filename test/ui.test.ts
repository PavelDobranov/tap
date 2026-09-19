import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeAgent } from "./helpers/fake-agent.ts";
import { freePort, killAllSessions, startTap, type TapSession } from "./helpers/run-tap.ts";
import { quit } from "./helpers/session.ts";
import { ask, printedUrl, snapshotAt } from "./helpers/snapshot.ts";
import { createCapture } from "../src/record/capture.ts";
import { createRecord } from "../src/record/record.ts";
import { startProxy } from "../src/proxy/proxy.ts";
import { startUi } from "../src/ui/server.ts";
import { startFakeUpstream } from "./helpers/fake-upstream.ts";

const agent = createFakeAgent();
after(() => agent.remove());
after(killAllSessions);

const scratch = mkdtempSync(path.join(tmpdir(), "tap-ui-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const argvFile = path.join(scratch, "argv.json");

interface Inspectable {
  readonly session: TapSession;
  /** The URL Tap printed, token and all. */
  readonly url: URL;
}

/**
 * Starts a session on a known port and waits for the UI URL to be printed.
 * The agent stays running unless the caller tells it to exit, so the same
 * helper serves both the live and the frozen assertions.
 */
async function inspectable(extra: NodeJS.ProcessEnv = {}): Promise<Inspectable> {
  const port = await freePort();
  const session = startTap(["launch", "--port", String(port), "claude"], {
    env: { PATH: agent.pathEnv, ...extra },
  });
  await session.waitForError(/http:\/\//);
  const printed = printedUrl(session.stderr());
  assert.ok(printed, "Tap must print the UI URL");
  return { session, url: new URL(printed) };
}

/** A routable address of this machine, if it has one. */
function externalAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

/** Whether anything is listening at an address, without sending a request. */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2_000 });
    const settle = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
    socket.on("timeout", () => settle(false));
  });
}

/** A record large enough to show whether snapshot serving monopolises the event loop. */
function largeRecord(): ReturnType<typeof createRecord> {
  const record = createRecord({ cap: 128 * 1024 * 1024 });
  const rawEvent = `data: ${"r".repeat(64 * 1024)}\n\n`;

  for (let seq = 1; seq <= 400; seq += 1) {
    const unique = `${seq}: ${"p".repeat(64 * 1024)}`;
    const entry = record.begin("POST", "/v1/messages");
    entry.observePayload(
      JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: unique }] }),
    );
    entry.observeRawResponse(rawEvent);
    entry.complete("closed");
  }

  return record;
}

interface ProxiedStream {
  readonly firstChunk: Promise<void>;
  readonly gaps: Promise<number[]>;
}

function readThroughProxy(baseUrl: string): ProxiedStream {
  const target = new URL("/v1/messages", baseUrl);
  const body = JSON.stringify({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
  });

  let sawFirst = false;
  let firstChunk!: () => void;
  let failedFirst!: (error: Error) => void;
  const first = new Promise<void>((resolve, reject) => {
    firstChunk = resolve;
    failedFirst = reject;
  });

  const gaps = new Promise<number[]>((resolve, reject) => {
    const req = httpRequest(
      target,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        const measured: number[] = [];
        let last: number | null = null;
        const fail = (error: Error) => {
          if (!sawFirst) failedFirst(error);
          reject(error);
        };
        response.on("data", () => {
          const now = performance.now();
          if (last !== null) measured.push(now - last);
          last = now;
          if (!sawFirst) {
            sawFirst = true;
            firstChunk();
          }
        });
        response.on("end", () => {
          if (!sawFirst) failedFirst(new Error("upstream stream ended without a chunk"));
          resolve(measured);
        });
        response.on("error", fail);
      },
    );
    req.on("error", (error) => {
      if (!sawFirst) failedFirst(error);
      reject(error);
    });
    req.end(body);
  });

  return { firstChunk: first, gaps };
}

test("the UI is served on its own loopback port, given by --port", async () => {
  const { session, url } = await inspectable();

  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  const snapshot = await snapshotAt(url.href);
  assert.deepEqual(snapshot.requests, []);
  assert.deepEqual(snapshot.diagnostics, []);

  session.type("exit 0");
  await quit(session);
});

test("serving a large snapshot yields often enough for forwarding to keep running", async () => {
  const record = largeRecord();
  const ui = await startUi(record, await freePort());
  const upstream = await startFakeUpstream({
    stream: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: [
        { gapMs: 0, text: "data: first\n\n" },
        { gapMs: 50, text: "data: second\n\n" },
        { gapMs: 50, text: "data: third\n\n" },
      ],
    },
  });
  const proxy = await startProxy(new URL(upstream.baseUrl), createCapture(record));

  try {
    const streamed = readThroughProxy(proxy.baseUrl);
    await streamed.firstChunk;
    const snapshot = snapshotAt(ui.url);
    const gaps = await streamed.gaps;

    assert.ok((await snapshot).requests.length >= 400);
    assert.ok(gaps.length >= 2, "the agent should receive the upstream response as chunks");
    assert.ok(
      gaps[0]! < 125,
      `serving the snapshot delayed the next forwarded chunk by ${gaps[0]!.toFixed(1)}ms`,
    );
  } finally {
    await proxy.close();
    await upstream.close();
    await ui.close();
  }
});

test("the UI port is fixed by default and separate from the proxy's", async () => {
  const session = startTap(["launch", "claude"], { env: { PATH: agent.pathEnv } });
  await session.waitForError(/http:\/\//);

  const first = new URL(printedUrl(session.stderr())!);
  session.type("exit 0");
  await quit(session);

  const again = startTap(["launch", "claude"], { env: { PATH: agent.pathEnv } });
  await again.waitForError(/http:\/\//);
  const second = new URL(printedUrl(again.stderr())!);
  again.type("exit 0");
  await quit(again);

  assert.equal(second.port, first.port, "the default port must be fixed, not ephemeral");
});

test("Tap prints the UI URL once, before the agent takes over and not after", async () => {
  const { session, url } = await inspectable();

  assert.doesNotMatch(session.stdout(), /http:/, "the URL is Tap's line, not the agent's");
  const printedBefore = session.stderr();
  assert.equal(
    printedBefore.match(/http:\/\//g)?.length,
    1,
    "the URL is printed exactly once",
  );

  session.type("echo hello");
  await session.waitForOutput(/agent: hello/);
  assert.equal(session.stderr(), printedBefore, "Tap says nothing while the agent runs");

  session.type("exit 0");
  await quit(session);
});

test("the printed URL carries a token that is not guessable from the URL alone", async () => {
  const { session, url } = await inspectable();

  const token = url.searchParams.get("token");
  assert.ok(token, "the UI URL must carry a token");
  assert.ok(token.length >= 32, `a ${token.length}-character token is too short`);

  session.type("exit 0");
  await quit(session);
});

test("a request with a missing or wrong token is refused", async () => {
  const { session, url } = await inspectable();
  const port = Number(url.port);
  const host = { host: url.host };

  const missing = await ask(port, "/", { headers: host });
  assert.equal(missing.status, 403);
  const wrong = await ask(port, "/?token=not-the-token", { headers: host });
  assert.equal(wrong.status, 403);
  assert.doesNotMatch(
    missing.body + wrong.body,
    new RegExp(url.searchParams.get("token")!),
    "a refusal must not hand out the token",
  );

  session.type("exit 0");
  await quit(session);
});

test("a request with an unexpected Host header is refused", async () => {
  const { session, url } = await inspectable();
  const port = Number(url.port);
  const target = `/?token=${url.searchParams.get("token")}`;

  // A name that resolves to loopback is exactly how a page in the browser
  // would try to reach the record; the port and the bare address are refused
  // for the same reason, since neither is an address Tap handed anyone.
  const wrong = ["tap.example.com", `evil.test:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`];
  for (const host of wrong) {
    const answer = await ask(port, target, { headers: { host } });
    assert.equal(answer.status, 403, `Host: ${host} should have been refused`);
  }
  assert.equal(
    (await ask(port, target, { headers: { host: `localhost:${port}` } })).status,
    200,
    "localhost is the same origin and must work",
  );

  session.type("exit 0");
  await quit(session);
});

test("the UI serves a snapshot and nothing else: no write endpoint exists", async () => {
  const { session, url } = await inspectable();
  const port = Number(url.port);
  const target = `/?token=${url.searchParams.get("token")}`;
  const host = { host: url.host };

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const answer = await ask(port, target, { method, headers: host });
    assert.equal(answer.status, 405, `${method} must not be accepted`);
  }
  const unknown = await ask(port, `/records${target}`, { headers: host });
  assert.equal(unknown.status, 404);

  session.type("exit 0");
  await quit(session);
});

test("the UI is not reachable from off the loopback address", async (t) => {
  const external = externalAddress();
  if (external === undefined) {
    t.skip("no non-loopback address on this machine");
    return;
  }

  const { session, url } = await inspectable();
  const port = Number(url.port);

  assert.equal(await reachable("127.0.0.1", port), true, "loopback should work");
  assert.equal(
    await reachable(external, port),
    false,
    "the UI serves the whole captured context and must stay on this machine",
  );

  session.type("exit 0");
  await quit(session);
});

test("the snapshot is still served, unchanged, once the agent has exited", async () => {
  const { session, url } = await inspectable();

  session.type("exit 0");
  await session.waitForError(/frozen/);

  const frozen = await snapshotAt(url.href);
  assert.deepEqual(frozen.requests, []);

  session.interrupt();
  await session.exited;
});

test("a UI port already in use ends the launch before the agent runs", async () => {
  const port = await freePort();
  const squatter = createServer();
  await new Promise<void>((resolve) => squatter.listen(port, "127.0.0.1", () => resolve()));

  const session = startTap(["launch", "--port", String(port), "claude"], {
    env: { PATH: agent.pathEnv },
  });
  const result = await session.exited;

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /port/i);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "should not print a stack trace");
  assert.equal(result.stdout, "", "the agent must not have run");

  await new Promise<void>((resolve) => squatter.close(() => resolve()));
});

test("an unusable --port is a usage error, not a session", async () => {
  for (const bad of ["0", "-1", "99999", "http", ""]) {
    const session = startTap(["launch", "--port", bad, "claude"], {
      env: { PATH: agent.pathEnv },
    });
    const result = await session.exited;
    assert.equal(result.code, 2, `--port ${bad} should be a usage error`);
    assert.match(result.stderr, /--port/);
    assert.equal(result.stdout, "", "no agent may be spawned");
  }
});

test("--port after the agent name belongs to the agent, not to Tap", async () => {
  const port = await freePort();
  const session = startTap(["launch", "--port", String(port), "claude", "--port", "9"], {
    env: { PATH: agent.pathEnv, FAKE_AGENT_ARGV_FILE: argvFile },
  });
  await session.waitForError(/http:\/\//);

  assert.equal(new URL(printedUrl(session.stderr())!).port, String(port));
  session.type("exit 0");
  await quit(session);

  assert.deepEqual(JSON.parse(readFileSync(argvFile, "utf8")), ["--port", "9"]);
});
