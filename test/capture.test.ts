import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { after, test } from "node:test";
import { createCapture, type RequestCapture } from "../src/record/capture.ts";
import type { Entry, Record } from "../src/record/record.ts";
import { fixtureBody, readSseFixture, type SseFixture } from "./helpers/fake-upstream.ts";
import { killAllSessions } from "./helpers/run-tap.ts";
import { createProber, quit, responds } from "./helpers/session.ts";
import { snapshotAt } from "./helpers/snapshot.ts";

const tap = createProber("capture");
after(() => tap.dispose());
after(killAllSessions);

test("every request that reaches the proxy is in the snapshot, in wire order", async () => {
  const api = await tap.upstream(responds("{}"));
  const { session, snapshot } = await tap.probe(
    [
      { method: "POST", path: "/v1/messages", body: '{"model":"claude-opus-5"}' },
      {
        method: "POST",
        path: "/v1/messages/count_tokens",
        body: '{"model":"claude-haiku-4-5"}',
      },
      { method: "GET", path: "/v1/models", body: "" },
    ],
    api.baseUrl,
  );

  const { requests } = await snapshot();
  assert.deepEqual(
    requests.map((r) => [r.seq, r.type, r.method, r.endpoint]),
    [
      [1, "messages", "POST", "/v1/messages"],
      [2, "count_tokens", "POST", "/v1/messages/count_tokens"],
      [3, "other", "GET", "/v1/models"],
    ],
    "an unrecognised request is typed `other`, not discarded",
  );

  await quit(session);
});

test("a captured request carries its model, status, timings and usage", async () => {
  const fixture = readSseFixture("message-stream");
  const api = await tap.upstream({ stream: fixture });
  const before = Date.now();
  const { transcript, session, snapshot } = await tap.probe(
    [{ body: '{"model":"claude-opus-5","messages":[{"role":"user"}]}' }],
    api.baseUrl,
  );

  const captured = (await snapshot()).requests[0]!;
  assert.equal(captured.model, "claude-opus-5");
  assert.equal(captured.status, 200);
  assert.ok(Date.parse(captured.startedAt) >= before, "startedAt must be a real time");
  assert.ok(captured.completedAt !== null, "a finished request must record when it ended");
  assert.ok(Date.parse(captured.completedAt) >= Date.parse(captured.startedAt));
  assert.ok(captured.durationMs !== null && captured.durationMs >= 500, "the fixture takes ~600ms");
  assert.deepEqual(captured.usage, {
    inputTokens: 417,
    cacheReadInputTokens: 3840,
    outputTokens: 9,
  });

  // The record is a copy of what went past, never a replacement for it.
  assert.equal(transcript().responses[0]!.body, fixtureBody(fixture));

  await quit(session);
});

test("a count_tokens answer records the count it reported", async () => {
  const api = await tap.upstream(responds('{"input_tokens":2145}'));
  const { session, snapshot } = await tap.probe(
    [{ path: "/v1/messages/count_tokens", body: '{"model":"claude-opus-5"}' }],
    api.baseUrl,
  );

  const captured = (await snapshot()).requests[0]!;
  assert.equal(captured.type, "count_tokens");
  assert.deepEqual(captured.usage, { inputTokens: 2145 });

  await quit(session);
});

test("a request appears in the snapshot when it starts, not when it completes", async () => {
  const slow: SseFixture = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks: [
      {
        gapMs: 0,
        text:
          'event: message_start\ndata: {"type":"message_start","message":' +
          '{"model":"claude-opus-5","usage":{"input_tokens":11}}}\n\n',
      },
      { gapMs: 1_500, text: 'event: message_stop\ndata: {"type":"message_stop"}\n\n' },
    ],
  };
  const api = await tap.upstream({ stream: slow });
  const { session, url } = await tap.probe([{}], api.baseUrl, "url");

  let inFlight;
  for (let waited = 0; waited < 10_000 && inFlight === undefined; waited += 20) {
    const { requests } = await snapshotAt(url);
    if (requests[0]?.status === 200) inFlight = requests[0];
    else await delay(20);
  }

  assert.ok(inFlight, "the request must be readable while it is still being answered");
  assert.equal(inFlight.completedAt, null, "an in-flight request is not a completed one");
  assert.equal(inFlight.durationMs, null);

  await session.waitForError(/frozen/);
  const finished = (await snapshotAt(url)).requests[0]!;
  assert.ok(finished.completedAt !== null, "and it completes in place, same sequence number");
  assert.equal(finished.seq, inFlight.seq);

  session.interrupt();
  await session.exited;
});

test("a provider error is captured with its status, like any other response", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "overloaded_error" } });
  const api = await tap.upstream({ status: 529, headers: { "retry-after": "12" }, body });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = (await snapshot()).requests[0]!;
  assert.equal(captured.status, 529);
  assert.equal(captured.completedAt !== null, true);
  assert.equal(transcript().responses[0]!.status, 529, "and the agent still saw it unaltered");

  await quit(session);
});

test("a request capture cannot read fails open: the agent is unaffected, a diagnostic is not", async () => {
  const api = await tap.upstream(responds('{"id":"msg_01"}'));
  // Not JSON. Capture has to parse a request body to know the model, so this
  // is a real parse failure on the real path, not a hook pretending to be one.
  const torn = '{"model":"claude-opus-5",';
  const { transcript, session, snapshot } = await tap.probe([{ body: torn }], api.baseUrl);

  assert.equal(api.requests[0]?.body, torn, "the upstream still got the exact bytes");
  assert.equal(transcript().responses[0]!.status, 200, "and the agent still got its answer");
  assert.equal(transcript().responses[0]!.body, '{"id":"msg_01"}');

  const { requests, diagnostics } = await snapshot();
  assert.equal(requests.length, 1, "the request is recorded even though it could not be read");
  assert.equal(requests[0]!.model, null);
  assert.equal(requests[0]!.status, 200);
  assert.equal(diagnostics.length, 1, "the failure is visible rather than silent");
  assert.equal(diagnostics[0]!.seq, 1);

  assert.equal(session.stdout(), "", "a capture failure must never reach the agent's terminal");

  await quit(session);
});

test("a response capture cannot read still reaches the agent chunk for chunk", async () => {
  const fixture = readSseFixture("message-stream");
  // The same stream, with every payload mangled: capture can make nothing of
  // it, and the agent must not be able to tell.
  const broken: SseFixture = {
    ...fixture,
    chunks: fixture.chunks.map((chunk) => ({
      ...chunk,
      text: chunk.text.replace(/data: \{/g, "data: {,"),
    })),
  };
  const api = await tap.upstream({ stream: broken });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  const received = transcript().responses[0]!;
  assert.equal(received.error, undefined);
  assert.equal(received.status, broken.status);
  assert.equal(received.body, fixtureBody(broken), "the bytes must be identical");
  assert.deepEqual(
    received.chunks.map((chunk) => chunk.text),
    broken.chunks.map((chunk) => chunk.text),
    "capture holding a chunk back would show up as chunks glued together",
  );
  for (const [index, chunk] of broken.chunks.entries()) {
    if (index === 0) continue;
    const elapsed = received.chunks[index]!.atMs - received.chunks[index - 1]!.atMs;
    assert.ok(
      elapsed >= chunk.gapMs * 0.5,
      `chunk ${index} arrived ${elapsed.toFixed(1)}ms after the last, gap was ${chunk.gapMs}ms`,
    );
  }

  const { requests, diagnostics } = await snapshot();
  assert.equal(requests[0]!.status, 200, "what could be read is still recorded");
  assert.equal(requests[0]!.usage, null, "and what could not be read is not invented");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.seq, 1);

  await quit(session);
});

test("one unreadable event does not cost the usage the rest of the stream reports", async () => {
  // The bad line comes first and the usage comes last, so this only passes if
  // capture kept reading past what it could not parse — and the stream is long
  // enough that a capture rescanning everything it had already seen would show
  // up as one.
  const chunks = [{ gapMs: 0, text: "event: message_start\ndata: {not json at all\n\n" }];
  for (let index = 0; index < 200; index += 1) {
    chunks.push({
      gapMs: 0,
      text:
        `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,` +
        `"delta":{"type":"text_delta","text":"chunk ${index} of a long answer"}}\n\n`,
    });
  }
  chunks.push({
    gapMs: 0,
    text:
      'event: message_delta\ndata: {"type":"message_delta",' +
      '"usage":{"output_tokens":73,"input_tokens":12}}\n\n',
  });

  const stream: SseFixture = {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    chunks,
  };
  const api = await tap.upstream({ stream });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  assert.equal(transcript().responses[0]!.status, 200);

  const { requests, diagnostics } = await snapshot();
  assert.deepEqual(
    requests[0]!.usage,
    { outputTokens: 73, inputTokens: 12 },
    "the events after the unreadable one are still read",
  );
  assert.equal(diagnostics.length, 1, "and the unreadable one is reported exactly once");

  await quit(session);
});

test("a compressed response is read for usage without the agent seeing it decoded", async () => {
  const body = JSON.stringify({
    id: "msg_01",
    model: "claude-opus-5",
    usage: { input_tokens: 812, cache_creation_input_tokens: 64, output_tokens: 30 },
  });
  const compressed = gzipSync(Buffer.from(body, "utf8"));
  const api = await tap.upstream({
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: compressed,
  });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  const received = transcript().responses[0]!;
  assert.equal(
    Buffer.from(received.body, "utf8").length > 0 && received.body !== body,
    true,
    "the agent gets the bytes the upstream sent, still compressed",
  );
  assert.equal(received.headers["content-encoding"], "gzip");

  const { requests, diagnostics } = await snapshot();
  assert.deepEqual(requests[0]!.usage, {
    inputTokens: 812,
    cacheCreationInputTokens: 64,
    outputTokens: 30,
  });
  assert.deepEqual(diagnostics, [], "decoding a copy is not a capture failure");

  await quit(session);
});

/**
 * Fail-open has one owner, so capture is total against a record that is not:
 * every method the proxy calls has to return normally however badly the record
 * beneath it behaves. This is the in-process seam because the subject is
 * capture's contract with the record, not anything process-shaped.
 */

/** A record that fails at whatever it is asked, keeping what it was told of it. */
function hostileRecord(begin: () => Entry): { record: Record; failures: unknown[] } {
  const failures: unknown[] = [];
  // Cast because capture only ever reaches for `begin` and `diagnose`; giving
  // the fake a `view`, a `freeze` and a `snapshot` it is never asked for would
  // describe more of the seam than there is.
  const record = {
    begin,
    diagnose: (_seq: number | null, detail: unknown) => failures.push(detail),
  } as unknown as Record;
  return { record, failures };
}

/** An entry that throws at every observation, and at being completed. */
function brokenEntry(): Entry {
  const explode = (): never => {
    throw new Error("the record is broken");
  };
  return {
    seq: 1,
    type: "messages",
    observeModel: explode,
    observePayload: explode,
    observeRawResponse: explode,
    observeStatus: explode,
    observeToolUse: explode,
    observeUsage: explode,
    complete: explode,
  };
}

/** Drives one request through a capture, the way the proxy drives one. */
function driveRequest(captured: RequestCapture): void {
  captured.requestChunk(Buffer.from('{"model":"claude-opus-5"}'));
  captured.requestEnd();
  captured.responseStart(200, { "content-type": "application/json" });
  captured.responseChunk(Buffer.from('{"usage":{"input_tokens":1}}'));
  captured.end("closed");
}

test("no capture method throws, whatever the record it is writing to does", () => {
  const { record, failures } = hostileRecord(brokenEntry);

  const captured = createCapture(record).begin("POST", "/v1/messages");
  assert.doesNotThrow(
    () => driveRequest(captured),
    "a capture step that throws into the proxy is a capture step in the agent's way",
  );
  assert.equal(failures.length, 1, "and the failure is written down rather than swallowed");
});

test("a capture that could not be opened is still a capture the proxy can call", () => {
  const { record, failures } = hostileRecord(() => {
    throw new Error("no entry for you");
  });

  const captured = createCapture(record).begin("POST", "/v1/messages");
  assert.doesNotThrow(
    () => driveRequest(captured),
    "the proxy holds a capture handle whether or not an entry was opened for it",
  );
  assert.equal(failures.length, 1, "and the entry that could not be opened is reported once");
});
