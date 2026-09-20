import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { performance } from "node:perf_hooks";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openUi } from "./helpers/browser.ts";
import { createFakeAgent } from "./helpers/fake-agent.ts";
import { freePort, killAllSessions, startTap, type TapSession } from "./helpers/run-tap.ts";
import { createProber, quit } from "./helpers/session.ts";
import { ask, printedUrl, snapshotAt } from "./helpers/snapshot.ts";
import { createCapture } from "../src/record/capture.ts";
import { createRecord } from "../src/record/record.ts";
import { startProxy } from "../src/proxy/proxy.ts";
import { startUi } from "../src/ui/server.ts";
import { readSseFixture, startFakeUpstream } from "./helpers/fake-upstream.ts";

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

interface SseMessage {
  readonly event: string;
  readonly id: number;
  readonly data: unknown;
}

interface SseViewer {
  next(): Promise<SseMessage>;
  /** Runs `act` the moment the opening frame's first bytes arrive. */
  disturb(act: () => void): void;
  close(): void;
}

/** Opens the browser's live HTTP seam and reads one framed event at a time. */
function openEvents(url: string): Promise<SseViewer> {
  const target = new URL(url);
  target.pathname = "/api/events";
  return new Promise((resolve, reject) => {
    const req = httpRequest(target, { headers: { accept: "text/event-stream" } });
    req.once("error", reject);
    req.once("response", (response) => {
      assert.equal(response.statusCode, 200);
      response.setEncoding("utf8");
      let disturb: (() => void) | null = null;
      let buffered = "";
      // Where the last search for a frame boundary gave up. Without it, a
      // snapshot of any size is rescanned from the start on every chunk, which
      // is quadratic in exactly the case worth testing.
      let searched = 0;
      const messages: SseMessage[] = [];
      const waiting: ((message: SseMessage) => void)[] = [];
      response.on("data", (chunk: string) => {
        // Fired once, on the first bytes of the opening frame: the only moment
        // at which a test can put the record and the snapshot in a race.
        if (disturb !== null) {
          const act = disturb;
          disturb = null;
          act();
        }
        buffered += chunk;
        for (;;) {
          const boundary = buffered.indexOf("\n\n", searched);
          if (boundary < 0) {
            searched = Math.max(0, buffered.length - 1);
            break;
          }
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          searched = 0;
          const fields = Object.fromEntries(
            frame.split("\n").map((line) => {
              const colon = line.indexOf(":");
              return [line.slice(0, colon), line.slice(colon + 1).trimStart()];
            }),
          );
          const message = {
            event: fields.event ?? "message",
            id: Number(fields.id),
            data: JSON.parse(fields.data ?? "null") as unknown,
          };
          const receive = waiting.shift();
          if (receive === undefined) messages.push(message);
          else receive(message);
        }
      });
      resolve({
        disturb: (act: () => void) => {
          disturb = act;
        },
        next: () =>
          new Promise((receive) => {
            const message = messages.shift();
            if (message === undefined) waiting.push(receive);
            else receive(message);
          }),
        close: () => req.destroy(),
      });
    });
    req.end();
  });
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

test("the printed URL serves the local request list with hardened browser headers", async () => {
  const { session, url } = await inspectable();
  const page = await ask(Number(url.port), `${url.pathname}${url.search}`, {
    headers: { host: url.host },
  });

  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.match(page.body, /<th[^>]*>Sequence<\/th>/);
  assert.match(page.body, /<th[^>]*>Tokens \/ cache<\/th>/);
  assert.doesNotMatch(page.body, new RegExp(url.searchParams.get("token")!));
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["x-content-type-options"], "nosniff");
  assert.equal(page.headers["cache-control"], "no-store");
  assert.match(String(page.headers["content-security-policy"]), /default-src 'self'/);

  const snapshot = await snapshotAt(url.href);
  assert.deepEqual(snapshot.requests, []);
  assert.equal(snapshot.lifecycle.phase, "live");

  session.type("exit 0");
  await quit(session);
});


test("the served page renders the record's rows and applies later request changes", async (t) => {
  const record = createRecord();
  const ui = await startUi(record, await freePort());
  t.after(() => ui.close());

  const entry = record.begin("POST", "/v1/messages");
  entry.observePayload('{"model":"claude-live","messages":[{"role":"user","content":"hello"}]}');
  entry.observeModel("claude-live");

  const browser = await openUi(ui.url);
  t.after(() => browser.close());
  const row = () => browser.find('#requests tr[data-seq="1"]');
  await browser.until("the request to reach the page", () => browser.all("#requests tr[data-seq]").length === 1);
  assert.deepEqual(
    row().children.slice(0, 5).map(({ textContent }) => textContent),
    ["1", "messages", "main", "claude-live", "in flight"],
  );

  entry.observeStatus(200);
  entry.observeUsage({ inputTokens: 12, outputTokens: 3 });
  entry.complete("closed");
  await browser.until("the request to complete", () => row().children[4]!.textContent === "200");
  const cells = row().children;
  assert.match(cells[6]!.textContent, /^\d+ ms$/);
  assert.equal(cells[7]!.textContent, "in 12 · out 3");
});


test("each live connection starts with a snapshot then receives ordered request deltas", async () => {
  const record = createRecord({ cap: 1 });
  const ui = await startUi(record, await freePort());
  const first = await openEvents(ui.url);
  const second = await openEvents(ui.url);

  try {
    const a = await first.next();
    const b = await second.next();
    assert.equal(a.event, "snapshot");
    assert.equal(b.event, "snapshot");
    assert.equal(a.id, 0);

    const entry = record.begin("POST", "/v1/messages");
    entry.observePayload('{"model":"claude-live","messages":[{"role":"user","content":"hello"}]}');
    entry.observeStatus(200);
    entry.observeRawResponse("data: hello\n\n");
    entry.complete("closed");

    const events: SseMessage[] = [];
    while (!events.some(({ data }) => (data as { type?: string }).type === "request-change" &&
      (data as { changes?: { completedAt?: string | null } }).changes?.completedAt != null)) {
      events.push(await first.next());
    }
    assert.ok(events.every(({ event }) => event === "delta"));
    assert.deepEqual(events.map(({ id }) => id), events.map(({ id }) => id).toSorted((x, y) => x - y));
    assert.ok(events.some(({ data }) => (data as { type?: string }).type === "request-start"));
    assert.ok(events.some(({ data }) => (data as { type?: string }).type === "raw-response"));
    assert.ok(events.some(({ data }) => (data as { type?: string }).type === "blob-added"));
    assert.ok(events.some(({ data }) => (data as { type?: string }).type === "blob-evicted"));
    assert.ok(events.some(({ data }) => (data as { type?: string }).type === "storage"));

    record.diagnose(entry.seq, "capture failed visibly");
    record.freeze({ code: null, signal: "SIGTERM" });
    while (!events.some(({ data }) => (data as { type?: string }).type === "frozen")) {
      events.push(await first.next());
    }
    assert.ok(events.some(({ data }) => (data as { type?: string }).type === "diagnostic"));
    const frozen = events.find(({ data }) => (data as { type?: string }).type === "frozen")!;
    assert.deepEqual((frozen.data as { agent: unknown }).agent, { code: null, signal: "SIGTERM" });

    const sameStart = await second.next();
    assert.equal((sameStart.data as { type?: string }).type, "request-start");
    first.close();
    const reconnected = await openEvents(ui.url);
    const fresh = await reconnected.next();
    assert.equal(fresh.event, "snapshot");
    assert.equal((fresh.data as { snapshot: { requests: unknown[] } }).snapshot.requests.length, 1);
    reconnected.close();
  } finally {
    first.close();
    second.close();
    await ui.close();
  }
});

test("a viewer under backpressure is disposable and a later viewer gets a fresh snapshot", async () => {
  const record = createRecord();
  const ui = await startUi(record, await freePort());
  const target = new URL(ui.url);
  target.pathname = "/api/events";
  const call = httpRequest(target);
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    call.once("response", resolve);
    call.once("error", reject);
    call.end();
  });
  await new Promise<void>((resolve) => response.once("data", () => resolve()));
  // The opening snapshot is now on the wire; only later deltas exercise the
  // no-buffer backpressure rule.
  await new Promise((resolve) => setTimeout(resolve, 20));
  response.pause();

  const closed = new Promise<void>((resolve) => response.once("close", () => resolve()));
  const entry = record.begin("POST", "/v1/messages");
  // A viewer that has stopped reading is one whose backlog keeps growing, not
  // one that merely took a write past the socket's high-water mark: capture
  // keeps publishing to it at full speed until it is plainly not draining.
  const beforeCapture = performance.now();
  for (let event = 0; event < 40; event += 1) entry.observeRawResponse("x".repeat(64 * 1024));
  const captureDelay = performance.now() - beforeCapture;
  assert.ok(captureDelay < 125, `stalled viewer delayed capture by ${captureDelay.toFixed(1)}ms`);
  response.resume();
  await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("stalled viewer stayed connected")), 2_000),
    ),
  ]);

  const reconnected = await openEvents(ui.url);
  try {
    const initial = await reconnected.next();
    assert.equal(initial.event, "snapshot");
    assert.equal((initial.data as { snapshot: { requests: unknown[] } }).snapshot.requests.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    record.begin("GET", "/later");
    assert.equal(((await reconnected.next()).data as { type: string }).type, "request-start");
  } finally {
    reconnected.close();
    call.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await ui.close();
  }
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

test("the UI routes are read-only", async () => {
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
  assert.deepEqual(frozen.lifecycle, { phase: "frozen", agent: { code: 0, signal: null } });

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

const prober = createProber("ui-live");
after(() => prober.dispose());

/** Drives one request across a live Tap session's proxy and drains the answer. */
async function crossProxy(port: number): Promise<void> {
  const streamed = readThroughProxy(`http://127.0.0.1:${port}`);
  await streamed.gaps;
}

test("a request crossing a live Tap session's proxy reaches an open viewer as it happens", async () => {
  const upstream = await prober.upstream({ stream: readSseFixture("message-stream") });
  // The probe makes one request and stays up, which is how the test learns the
  // proxy's port while the session is still live.
  const probed = await prober.probe([{}], upstream.baseUrl, "transcript");
  const viewer = await openEvents(probed.url);

  try {
    const opening = await viewer.next();
    assert.equal(opening.event, "snapshot");
    const { snapshot } = opening.data as { snapshot: { requests: { seq: number }[] } };
    assert.deepEqual(snapshot.requests.map(({ seq }) => seq), [1]);

    // A second request crosses the proxy with the viewer already watching: it
    // must arrive as deltas on this connection, with no second fetch.
    await crossProxy(probed.proxyPort());

    const deltas: SseMessage[] = [];
    const about = () =>
      deltas.filter(({ data }) => (data as { seq?: number; request?: { seq: number } }).seq === 2 ||
        (data as { request?: { seq: number } }).request?.seq === 2);
    const completed = () =>
      about().some(({ data }) =>
        (data as { type: string; changes?: { completedAt?: string | null } }).type ===
          "request-change" &&
        (data as { changes?: { completedAt?: string | null } }).changes?.completedAt != null);
    while (!completed()) deltas.push(await viewer.next());

    const mine = about();
    assert.ok(deltas.every(({ event }) => event === "delta"));
    const ids = deltas.map(({ id }) => id);
    assert.deepEqual(ids, ids.toSorted((x, y) => x - y), "revisions must only increase");

    // Wire order: the second request to reach the proxy is the second row.
    const start = mine[0]!;
    assert.equal((start.data as { type: string }).type, "request-start");
    assert.equal((start.data as { request: { seq: number; type: string } }).request.seq, 2);
    assert.equal((start.data as { request: { type: string } }).request.type, "messages");

    // The row makes incoming response activity visible before it completes.
    assert.ok(
      mine.some(({ data }) => (data as { type: string }).type === "raw-response"),
      "the viewer should see the response arriving",
    );

    const changes = Object.assign(
      {},
      ...mine
        .filter(({ data }) => (data as { type: string }).type === "request-change")
        .map(({ data }) => (data as { changes: object }).changes),
    ) as {
      status?: number;
      model?: string | null;
      thread?: number | null;
      completedAt?: string | null;
      durationMs?: number | null;
      usage?: { inputTokens?: number; cacheReadInputTokens?: number } | null;
    };
    assert.equal(changes.status, 200);
    assert.equal(changes.thread, 1);
    // The model is read off the request as soon as it is forwarded, then
    // refined to whatever the response says actually served it.
    const models = mine
      .map(({ data }) => (data as { changes?: { model?: string | null } }).changes?.model)
      .filter((model) => model !== undefined);
    assert.deepEqual(models, ["claude-test", "claude-opus-5"]);
    assert.equal(changes.model, "claude-opus-5");
    assert.equal(typeof changes.durationMs, "number");
    assert.equal(changes.usage?.inputTokens, 417);
    assert.equal(changes.usage?.cacheReadInputTokens, 3840);
  } finally {
    viewer.close();
    probed.session.type("exit");
    await quit(probed.session);
  }
});

test("a request concurrent with connection setup arrives exactly once, after the snapshot", async () => {
  // Big enough that the opening snapshot is written in many pieces, so a
  // request can genuinely land in the middle of one.
  const record = createRecord();
  for (let seq = 1; seq <= 40; seq += 1) {
    const entry = record.begin("POST", "/v1/messages");
    entry.observePayload(
      JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: `${seq}: ${"p".repeat(4096)}` }] }),
    );
    entry.complete("closed");
  }
  const ui = await startUi(record, await freePort());
  const viewer = await openEvents(ui.url);

  try {
    // The request lands the instant the opening frame starts flowing, so the
    // connection has a snapshot half-written when the record moves under it.
    viewer.disturb(() => record.begin("POST", "/v1/messages"));

    const opening = await viewer.next();
    assert.equal(opening.event, "snapshot");
    const { snapshot } = opening.data as {
      snapshot: { requests: { seq: number }[]; revision: number };
    };
    // Whichever side of the snapshot it fell, it is there once and once only.
    const inSnapshot = snapshot.requests.filter(({ seq }) => seq === 41).length;
    assert.ok(inSnapshot <= 1);

    const delta = await viewer.next();
    assert.equal(delta.event, "delta");
    assert.ok(delta.id > snapshot.revision, "a delta must follow the snapshot's revision");
    const started = (delta.data as { type: string; request?: { seq: number } });
    const inDeltas = started.type === "request-start" && started.request?.seq === 41 ? 1 : 0;
    assert.equal(inSnapshot + inDeltas, 1, "the request must appear exactly once");
  } finally {
    viewer.close();
    await ui.close();
  }
});

test("an agent killed by a signal freezes the record as a signal, not as a code", async () => {
  const { session, url } = await inspectable();

  session.type("signal SIGTERM");
  await session.waitForError(/frozen/);

  const frozen = await snapshotAt(url.href);
  assert.deepEqual(frozen.lifecycle, {
    phase: "frozen",
    agent: { code: null, signal: "SIGTERM" },
  });

  session.interrupt();
  await session.exited;
});

test("every line of browser code is Tap's own and reaches nothing remote", async (t) => {
  const record = createRecord();
  const ui = await startUi(record, await freePort());
  t.after(() => ui.close());
  const url = new URL(ui.url);
  const fetchText = async (route: string): Promise<string> => {
    const answer = await ask(Number(url.port), `${route}${url.search}`, {
      headers: { host: url.host },
    });
    assert.equal(answer.status, 200);
    return answer.body;
  };

  const page = await fetchText("/");
  const app = await fetchText("/app.js");
  const style = await fetchText("/style.css");

  for (const [name, source] of [["page", page], ["app.js", app], ["style.css", style]] as const) {
    assert.doesNotMatch(source, /https?:\/\//, `${name} must name no remote origin`);
    assert.doesNotMatch(source, /\bsrc\s*=\s*["']\/\//, `${name} must use no protocol-relative URL`);
    assert.doesNotMatch(source, /@import/, `${name} must import nothing`);
  }
  // Everything the page loads is a route this server serves itself.
  const referenced = [...page.matchAll(/(?:src|href)="([^"]*)"/g)].map(([, value]) => value);
  assert.deepEqual(referenced.toSorted(), ["/app.js", "/style.css"]);
  assert.doesNotMatch(app, /\bfetch\s*\(|XMLHttpRequest|importScripts/);
  // The only connection it opens is the live one, on this origin.
  assert.deepEqual([...app.matchAll(/new EventSource\(([^)]*)\)/g)].length, 1);
  assert.match(app, /new EventSource\("\/api\/events"/);
});

test("the token never appears in the record's events, diagnostics, or Tap's output", async () => {
  const upstream = await prober.upstream({ stream: readSseFixture("message-stream") });
  const probed = await prober.probe([{}], upstream.baseUrl, "transcript");
  const token = new URL(probed.url).searchParams.get("token")!;
  const viewer = await openEvents(probed.url);

  try {
    const frames: SseMessage[] = [await viewer.next()];
    await crossProxy(probed.proxyPort());
    while (!frames.some(({ data }) => (data as { type?: string }).type === "request-change")) {
      frames.push(await viewer.next());
    }
    for (const frame of frames) {
      assert.ok(!JSON.stringify(frame.data).includes(token), `${frame.event} carried the token`);
    }

    const snapshot = await probed.snapshot();
    assert.ok(!JSON.stringify(snapshot).includes(token), "the snapshot carried the token");

    // Printed once, as the address a viewer needs, and written down nowhere else.
    assert.ok(!probed.session.stdout().includes(token), "stdout carried the token");
    const lines = probed.session.stderr().split("\n").filter((line) => line.includes(token));
    assert.equal(lines.length, 1, "the token belongs to the printed URL alone");
    assert.match(lines[0]!, /^tap: inspect this session at http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  } finally {
    viewer.close();
    probed.session.type("exit");
    await quit(probed.session);
  }
});

test("a stalled viewer is dropped on its own while another keeps receiving", async () => {
  const record = createRecord();
  const ui = await startUi(record, await freePort());
  const target = new URL(ui.url);
  target.pathname = "/api/events";

  // One viewer that stops reading, and one that keeps up.
  const stalling = httpRequest(target);
  const stalled = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    stalling.once("response", resolve);
    stalling.once("error", reject);
    stalling.end();
  });
  await new Promise<void>((resolve) => stalled.once("data", () => resolve()));
  const healthy = await openEvents(ui.url);
  assert.equal((await healthy.next()).event, "snapshot");

  await new Promise((resolve) => setTimeout(resolve, 20));
  stalled.pause();

  const dropped = new Promise<void>((resolve) => stalled.once("close", () => resolve()));

  try {
    // Spread over ticks, the way response events actually arrive: a viewer
    // that is reading drains each one, and only the viewer that is not reading
    // accumulates. A burst published in one synchronous run would leave every
    // viewer equally behind, which is not what a stalled viewer means.
    const entry = record.begin("POST", "/v1/messages");
    for (let event = 0; event < 80; event += 1) {
      entry.observeRawResponse("x".repeat(256 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    entry.observeStatus(200);
    entry.complete("closed");

    // The stalled viewer goes, and no catch-up buffer is kept for it.
    stalled.resume();
    await Promise.race([
      dropped,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the stalled viewer stayed connected")), 2_000)),
    ]);

    // The viewer that kept reading is untouched: it still has the whole
    // record, down to the response events the stalled one was dropped over.
    const kinds: string[] = [];
    const completed = () =>
      kinds.includes("completed");
    while (!completed()) {
      const message = await healthy.next();
      assert.equal(message.event, "delta");
      const data = message.data as { type: string; changes?: { completedAt?: string | null } };
      kinds.push(data.type);
      if (data.type === "request-change" && data.changes?.completedAt != null) kinds.push("completed");
    }
    assert.ok(kinds.includes("request-start"));
    assert.equal(kinds.filter((kind) => kind === "raw-response").length, 80);

    // And it is still live afterwards, rather than quietly wedged.
    record.begin("GET", "/later");
    let after = await healthy.next();
    while ((after.data as { type: string }).type !== "request-start") after = await healthy.next();
    assert.equal((after.data as { request: { seq: number } }).request.seq, 2);
  } finally {
    healthy.close();
    stalling.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    await ui.close();
  }
});

test("a record too big for one socket buffer still opens with a complete snapshot", async () => {
  // The opening snapshot is the one thing a viewer cannot do without, and a
  // record this size is exactly the one worth opening the UI on: filling the
  // socket while writing it is ordinary, not a stalled viewer.
  const record = createRecord({ cap: 128 * 1024 * 1024 });
  const requests = 50;
  for (let seq = 1; seq <= requests; seq += 1) {
    const entry = record.begin("POST", "/v1/messages");
    entry.observePayload(
      JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: `${seq}: ${"p".repeat(64 * 1024)}` }],
      }),
    );
    entry.observeRawResponse(`data: ${"r".repeat(64 * 1024)}\n\n`);
    entry.complete("closed");
  }
  const ui = await startUi(record, await freePort());
  const viewer = await openEvents(ui.url);

  try {
    const opening = await viewer.next();
    assert.equal(opening.event, "snapshot");
    const { snapshot } = opening.data as {
      snapshot: { requests: { seq: number }[]; revision: number };
    };
    assert.equal(snapshot.requests.length, requests);
    assert.deepEqual(
      snapshot.requests.map(({ seq }) => seq),
      snapshot.requests.map((_, index) => index + 1),
    );

    // And the connection is still good for the deltas that follow it. The
    // pause lets the server finish opening: a delta racing the end of the
    // snapshot is the separate concern tested above.
    await new Promise((resolve) => setTimeout(resolve, 50));
    record.begin("GET", "/later");
    const next = await viewer.next();
    assert.equal(next.event, "delta");
    assert.equal((next.data as { type: string }).type, "request-start");
    assert.equal((next.data as { request: { seq: number } }).request.seq, requests + 1);
    assert.ok(next.id > snapshot.revision);
  } finally {
    viewer.close();
    await ui.close();
  }
});

test("a viewer opens on the first try while the record is still moving", async () => {
  // The case the UI exists for: a record busy enough to be worth watching.
  // Disposing the connection on the first change that lands mid-snapshot
  // would mean this viewer never finishes opening at all.
  const record = createRecord({ cap: 128 * 1024 * 1024 });
  for (let seq = 1; seq <= 50; seq += 1) {
    const entry = record.begin("POST", "/v1/messages");
    entry.observePayload(
      JSON.stringify({
        model: "claude-test",
        messages: [{ role: "user", content: `${seq}: ${"p".repeat(64 * 1024)}` }],
      }),
    );
    entry.complete("closed");
  }
  const ui = await startUi(record, await freePort());
  const streaming = record.begin("POST", "/v1/messages");
  const ticking = setInterval(() => streaming.observeRawResponse("data: chunk\n\n"), 5);

  const viewer = await openEvents(ui.url);
  try {
    const opening = await viewer.next();
    assert.equal(opening.event, "snapshot");
    const { snapshot } = opening.data as {
      snapshot: { requests: { seq: number }[]; revision: number };
    };
    assert.equal(snapshot.requests.length, 51);

    // And the deltas that piled up behind it follow, in order, on the same
    // connection rather than after a reconnect.
    let last = snapshot.revision;
    for (let delta = 0; delta < 5; delta += 1) {
      const message = await viewer.next();
      assert.equal(message.event, "delta");
      assert.ok(message.id > last, `revision ${message.id} must follow ${last}`);
      last = message.id;
    }
  } finally {
    clearInterval(ticking);
    viewer.close();
    await ui.close();
  }
});
