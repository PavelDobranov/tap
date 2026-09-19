import assert from "node:assert/strict";
import { connect } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { createFakeAgent, PROBE_AGENT } from "./helpers/fake-agent.ts";
import type { ProbeStep, ProbeTranscript } from "./helpers/fake-agent.ts";
import {
  fixtureBody,
  readSseFixture,
  startFakeUpstream,
  type UpstreamPlan,
} from "./helpers/fake-upstream.ts";
import { startTap, type TapSession } from "./helpers/run-tap.ts";

const agent = createFakeAgent(PROBE_AGENT);
after(() => agent.remove());

const scratch = mkdtempSync(path.join(tmpdir(), "tap-proxy-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let probeFiles = 0;

interface Probed {
  readonly transcript: ProbeTranscript;
  readonly session: TapSession;
  /** The proxy's port, taken from the base URL the agent was handed. */
  readonly proxyPort: number;
}

/**
 * Runs one Tap session whose agent is the probe, and reads its transcript.
 *
 * `stay` leaves the agent running once it has written the transcript, for the
 * assertions that need a live session; otherwise the session is read frozen.
 */
async function probe(
  script: readonly ProbeStep[],
  upstreamBaseUrl: string,
  options: { stay?: boolean } = {},
): Promise<Probed> {
  const file = path.join(scratch, `probe-${probeFiles++}.json`);
  const session = startTap(["launch", "claude"], {
    env: {
      PATH: agent.pathEnv,
      ANTHROPIC_BASE_URL: upstreamBaseUrl,
      FAKE_AGENT_PROBE_FILE: file,
      FAKE_AGENT_PROBE_SCRIPT: JSON.stringify(script),
      ...(options.stay === true ? { FAKE_AGENT_PROBE_STAY: "1" } : {}),
    },
  });

  if (options.stay === true) await waitForFile(file);
  else await session.waitForError(/frozen/);

  const transcript = JSON.parse(readFileSync(file, "utf8")) as ProbeTranscript;
  return { transcript, session, proxyPort: Number(new URL(transcript.baseUrl).port) };
}

/** Ends a session the way a user does, and waits for Tap to go. */
async function quit(session: TapSession): Promise<void> {
  await session.waitForError(/frozen/);
  session.interrupt();
  await session.exited;
}

async function waitForFile(file: string): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 20) {
    if (existsSync(file)) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

/** Starts a fake upstream that is torn down with the test file. */
async function upstream(plan: UpstreamPlan) {
  const server = await startFakeUpstream(plan);
  after(() => server.close());
  return server;
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

/** A routable address of this machine, if it has one. */
function externalAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

const response = (body: string): UpstreamPlan => ({ body });

/** A raw header list read back as the name/value pairs that arrived. */
function rawPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    pairs.push([raw[index]!, raw[index + 1]!]);
  }
  return pairs;
}

/** Every TypeScript file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("the agent is pointed at Tap on the loopback address, not at the upstream", async () => {
  const api = await upstream(response("{}"));
  const { transcript, session, proxyPort } = await probe([{}], api.baseUrl);

  const base = new URL(transcript.baseUrl);
  assert.equal(base.protocol, "http:");
  assert.equal(base.hostname, "127.0.0.1");
  assert.notEqual(proxyPort, Number(new URL(api.baseUrl).port));
  assert.equal(api.requests.length, 1, "the request went through Tap");

  await quit(session);
});

test("the proxy is not reachable from off the loopback address", async (t) => {
  const external = externalAddress();
  if (external === undefined) {
    t.skip("no non-loopback address on this machine");
    return;
  }

  const api = await upstream(response("{}"));
  const { session, proxyPort } = await probe([{}], api.baseUrl, { stay: true });

  assert.equal(await reachable("127.0.0.1", proxyPort), true, "loopback should work");
  assert.equal(
    await reachable(external, proxyPort),
    false,
    "a wildcard bind would make Tap an open credential relay",
  );

  session.type("exit");
  await quit(session);
});

test("request method, path, headers and body reach the upstream unaltered", async () => {
  const api = await upstream(response("{}"));
  const body = JSON.stringify({ model: "claude-opus-5", messages: [{ role: "user" }] });
  const { session } = await probe(
    [
      {
        method: "POST",
        path: "/v1/messages?beta=true",
        headers: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
          "X-Stainless-Lang": "js",
          "user-agent": "claude-cli/2.0.0",
        },
        body,
      },
      { method: "POST", path: "/v1/messages/count_tokens", body: "{}" },
      { method: "GET", path: "/v1/models", body: "" },
    ],
    api.baseUrl,
  );

  const [messages, count, models] = api.requests;
  assert.equal(messages?.method, "POST");
  assert.equal(messages?.url, "/v1/messages?beta=true");
  assert.equal(messages?.body, body);
  assert.equal(messages?.headers["anthropic-version"], "2023-06-01");
  assert.equal(
    messages?.headers["anthropic-beta"],
    "fine-grained-tool-streaming-2025-05-14",
  );
  assert.equal(messages?.headers["x-stainless-lang"], "js");
  assert.equal(messages?.headers["user-agent"], "claude-cli/2.0.0");
  assert.equal(
    messages?.headers["host"],
    new URL(api.baseUrl).host,
    "Host names the upstream, which is the one header a reverse proxy must own",
  );
  assert.deepEqual(
    rawPairs(messages!.rawHeaders).filter(([name]) => name.startsWith("X-Stainless")),
    [["X-Stainless-Lang", "js"]],
    "header names keep the case the agent chose",
  );
  assert.equal(count?.url, "/v1/messages/count_tokens");
  assert.equal(models?.method, "GET");
  assert.equal(models?.url, "/v1/models");

  await quit(session);
});

test("an upstream with a path of its own keeps it in front of the agent's", async () => {
  const api = await upstream(response("{}"));
  const { session } = await probe([{ path: "/v1/messages" }], `${api.baseUrl}/llm`);

  assert.equal(api.requests[0]?.url, "/llm/v1/messages");

  await quit(session);
});

test("a streamed response reaches the agent chunk for chunk, gaps and all", async () => {
  const fixture = readSseFixture("message-stream");
  const api = await upstream({ stream: fixture });
  const { transcript, session } = await probe([{}], api.baseUrl);

  const received = transcript.responses[0]!;
  assert.equal(received.error, undefined);
  assert.equal(received.status, fixture.status);
  assert.equal(received.headers["content-type"], fixture.headers["content-type"]);

  assert.equal(received.body, fixtureBody(fixture), "the bytes must be identical");
  assert.deepEqual(
    received.chunks.map((chunk) => chunk.text),
    fixture.chunks.map((chunk) => chunk.text),
    "buffering shows up as chunks glued together",
  );

  // Timing is a floor, not an equality: the machine can be slow, but a proxy
  // that holds a chunk back cannot make one arrive early.
  for (const [index, chunk] of fixture.chunks.entries()) {
    if (index === 0) continue;
    const elapsed = received.chunks[index]!.atMs - received.chunks[index - 1]!.atMs;
    assert.ok(
      elapsed >= chunk.gapMs * 0.5,
      `chunk ${index} arrived ${elapsed.toFixed(1)}ms after the last, gap was ${chunk.gapMs}ms`,
    );
  }

  await quit(session);
});

test("the credential reaches the upstream verbatim and is never spoken of", async () => {
  const sentinel = "sk-ant-sentinel-0d2f4c7a9b1e";
  const api = await upstream(response("{}"));
  const { session } = await probe(
    [{ headers: { Authorization: `Bearer ${sentinel}` } }],
    api.baseUrl,
  );

  assert.deepEqual(
    rawPairs(api.requests[0]!.rawHeaders).filter(([name]) => /^authoriz/i.test(name)),
    [["Authorization", `Bearer ${sentinel}`]],
    "name, case and value all cross Tap untouched",
  );

  const said = session.stdout() + session.stderr();
  assert.doesNotMatch(said, new RegExp(sentinel), "Tap must never repeat a credential");

  await quit(session);
});

test("no code in Tap so much as names the credential header", () => {
  // The invariant is that the header is copied without being read, and the
  // only way to read it is to name it. Scanning the source catches the
  // mistake a behavioural test cannot: a debug path that stores the
  // credential somewhere no assertion happens to look. Comments are stripped
  // so that documenting the invariant is not a violation of it.
  for (const file of sourceFiles(fileURLToPath(new URL("../src/", import.meta.url)))) {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.doesNotMatch(
      code,
      /authoriz/i,
      `${file} names the credential header; it may only be copied`,
    );
  }
});

test("a non-streaming response passes through unaltered", async () => {
  const body = JSON.stringify({ id: "msg_01", content: [{ type: "text", text: "hi" }] });
  const api = await upstream({
    status: 200,
    headers: { "content-type": "application/json", "anthropic-request-id": "req_01" },
    body,
  });
  const { transcript, session } = await probe([{}], api.baseUrl);

  const received = transcript.responses[0]!;
  assert.equal(received.status, 200);
  assert.equal(received.body, body);
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers["anthropic-request-id"], "req_01");

  await quit(session);
});

test("an upstream error passes through unaltered", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "overloaded_error" } });
  const api = await upstream({ status: 529, headers: { "retry-after": "12" }, body });
  const { transcript, session } = await probe([{}], api.baseUrl);

  const received = transcript.responses[0]!;
  assert.equal(received.status, 529);
  assert.equal(received.body, body);
  assert.equal(received.headers["retry-after"], "12");

  await quit(session);
});

test("the proxy stops accepting requests once the agent has exited", async () => {
  const api = await upstream(response("{}"));
  const { session, proxyPort } = await probe([{}], api.baseUrl);

  // The session is frozen here: the record would still be readable, but there
  // is no agent left to record, so nothing may still be forwarded upstream.
  assert.equal(await reachable("127.0.0.1", proxyPort), false);

  await quit(session);
  assert.equal(await reachable("127.0.0.1", proxyPort), false);
});
