import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, test } from "node:test";
import { fixtureBody, readSseFixture, type SseFixture } from "./helpers/fake-upstream.ts";
import { killAllSessions } from "./helpers/run-tap.ts";
import { createProber, quit, responds } from "./helpers/session.ts";
import { payloadOf, snapshotAt } from "./helpers/snapshot.ts";

const tap = createProber("payload");
after(() => tap.dispose());
after(killAllSessions);

test("every request's payload comes back byte for byte as the upstream got it", async () => {
  const api = await tap.upstream(responds("{}"));
  // Whitespace, key order and a non-ASCII character are all things a capture
  // that re-serialised what it parsed would quietly change.
  const messages = '{ "model":"claude-opus-5",\n  "messages":[{"role":"user","content":"héllo ▲"}] }';
  const countTokens = '{"model":"claude-haiku-4-5","messages":[]}';
  // An `other` request is not parsed at all, and its body is kept regardless:
  // the request Tap does not understand is the one worth having in full.
  const other = "not json, not a shape tap knows";

  const { session, snapshot } = await tap.probe(
    [
      { path: "/v1/messages", body: messages },
      { path: "/v1/messages/count_tokens", body: countTokens },
      { path: "/v1/models", body: other },
    ],
    api.baseUrl,
  );

  const captured = await snapshot();
  const payloads = captured.requests.map((request) => payloadOf(captured, request));
  assert.deepEqual(payloads, [messages, countTokens, other]);
  assert.deepEqual(
    payloads,
    api.requests.map((request) => request.body),
    "the payload reconstructed from the record is the payload the upstream received",
  );
  assert.ok(
    captured.requests[0]!.skeleton!.some((part) => typeof part !== "string"),
    "and a body tap understands is held as references rather than as itself",
  );
  assert.deepEqual(
    captured.requests[2]!.skeleton,
    [other],
    "while one it does not is kept whole, not guessed at",
  );

  await quit(session);
});

test("the raw response is held event by event, exactly as it streamed", async () => {
  const fixture = readSseFixture("message-stream");
  const api = await tap.upstream({ stream: fixture });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = (await snapshot()).requests[0]!;
  assert.equal(
    captured.rawResponse.join(""),
    fixtureBody(fixture),
    "verbatim: nothing added, dropped or reframed",
  );
  // Framed by event rather than by chunk — the fifth chunk of this fixture
  // carries two — so what the record holds is what the stream said, not how
  // the network happened to slice it.
  assert.deepEqual(
    captured.rawResponse.map((event) => /^event: (\S+)/.exec(event)?.[1]),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );

  // Accumulating is not allowed to cost the agent the stream it would have had
  // without Tap: same bytes, same chunks, same pauses between them.
  const received = transcript().responses[0]!;
  assert.equal(received.body, fixtureBody(fixture));
  assert.deepEqual(
    received.chunks.map((chunk) => chunk.text),
    fixture.chunks.map((chunk) => chunk.text),
  );
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

test("a response still in flight is readable as far as it has got", async () => {
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
      {
        gapMs: 1_500,
        text:
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
          '"delta":{"type":"text_delta","text":"late"}}\n\nevent: message_stop\n' +
          'data: {"type":"message_stop"}\n\n',
      },
    ],
  };
  const api = await tap.upstream({ stream: slow });
  const { session, url } = await tap.probe([{}], api.baseUrl, "url");

  let inFlight;
  for (let waited = 0; waited < 10_000 && inFlight === undefined; waited += 20) {
    const { requests } = await snapshotAt(url);
    if ((requests[0]?.rawResponse.length ?? 0) > 0) inFlight = requests[0];
    else await delay(20);
  }

  assert.ok(inFlight, "the first event must be readable while the rest is still coming");
  assert.equal(inFlight.completedAt, null, "and the response is not finished");
  assert.deepEqual(
    inFlight.rawResponse,
    [slow.chunks[0]!.text],
    "what has arrived, and nothing the upstream has not sent yet",
  );

  await session.waitForError(/frozen/);
  const finished = (await snapshotAt(url)).requests[0]!;
  assert.equal(finished.rawResponse.length, 3, "the rest lands in the same entry");
  assert.equal(finished.rawResponse.join(""), slow.chunks.map((chunk) => chunk.text).join(""));
  assert.equal(finished.interrupted, false, "a stream the upstream closed is not interrupted");

  session.interrupt();
  await session.exited;
});

test("a stream cut mid-response keeps what it got, and says it was cut", async () => {
  const fixture = readSseFixture("message-stream");
  const delivered = fixture.chunks.slice(0, 3);
  const api = await tap.upstream({ stream: { ...fixture, chunks: delivered }, cut: true });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = (await snapshot()).requests[0]!;
  assert.equal(captured.status, 200);
  assert.equal(captured.interrupted, true, "a cut response must not read as a complete one");
  assert.equal(captured.completedAt !== null, true, "it is over, however it ended");
  assert.equal(
    captured.rawResponse.join(""),
    delivered.map((chunk) => chunk.text).join(""),
    "everything that arrived before the cut is the record",
  );
  assert.deepEqual(captured.usage, { inputTokens: 417, cacheReadInputTokens: 3840, outputTokens: 1 });

  // The agent saw the same cut stream Tap recorded, and Tap did not
  // invent an ending for either of them.
  assert.equal(transcript().responses[0]!.body, delivered.map((chunk) => chunk.text).join(""));

  await quit(session);
});

test("a response that is not a stream is kept whole, errors included", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "overloaded_error" } });
  const api = await tap.upstream({ status: 529, body });
  const { session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = (await snapshot()).requests[0]!;
  assert.equal(captured.status, 529);
  assert.deepEqual(captured.rawResponse, [body], "the provider's answer is evidence like any other");
  assert.equal(captured.interrupted, false);

  await quit(session);
});

test("a body capture cannot parse is still a body capture kept", async () => {
  const api = await tap.upstream(responds('{"id":"msg_01"}'));
  const torn = '{"model":"claude-opus-5",';
  const { transcript, session, snapshot } = await tap.probe([{ body: torn }], api.baseUrl);

  const captured = await snapshot();
  const { requests, diagnostics } = captured;
  assert.equal(payloadOf(captured, requests[0]!), torn, "unreadable is not the same as unrecorded");
  assert.equal(requests[0]!.model, null, "and nothing is invented from what could not be read");
  assert.equal(diagnostics.length, 1, "the parse failure is still visible");

  assert.equal(transcript().responses[0]!.status, 200, "the agent is unaffected, as ever");
  assert.equal(session.stdout(), "");

  await quit(session);
});

test("a response past the capture budget keeps what fits and says it stopped", async () => {
  // One megabyte per event, past Tap's 32MB hold. The record is capped; the
  // stream through the proxy is not.
  const event = (index: number): string =>
    `event: content_block_delta\ndata: {"index":${index},"text":"${"x".repeat(1_000_000)}"}\n\n`;
  const chunks = Array.from({ length: 40 }, (_, index) => ({ gapMs: 0, text: event(index) }));
  const api = await tap.upstream({
    stream: { status: 200, headers: { "content-type": "text/event-stream" }, chunks },
  });
  const { transcript, session, snapshot } = await tap.probe([{}], api.baseUrl);

  assert.equal(
    transcript().responses[0]!.body.length,
    chunks.reduce((total, chunk) => total + chunk.text.length, 0),
    "every byte still reached the agent",
  );

  const { requests, diagnostics } = await snapshot();
  const captured = requests[0]!;
  assert.ok(captured.rawResponse.length > 0, "what arrived before the budget ran out is kept");
  assert.ok(
    captured.rawResponse.length < chunks.length,
    "and capture stopped rather than holding the whole stream",
  );
  assert.equal(diagnostics.length, 1, "stopping is said out loud, once");
  assert.match(diagnostics[0]!.detail, /budget/);

  await quit(session);
});

test("a stream cut in the middle of an event keeps the half it got, as it got it", async () => {
  const whole = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n';
  // No blank line: the upstream went away with the event still open.
  const half = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":';
  const api = await tap.upstream({
    stream: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: [
        { gapMs: 0, text: whole },
        { gapMs: 0, text: half },
      ],
    },
    cut: true,
  });
  const { session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = (await snapshot()).requests[0]!;
  assert.equal(captured.interrupted, true);
  assert.deepEqual(
    captured.rawResponse,
    [whole, half],
    "the half event is kept exactly as it arrived, not closed off with bytes nobody sent",
  );
  assert.deepEqual(captured.usage, { inputTokens: 7 }, "and what could be read off it still was");

  await quit(session);
});

test("a character split across two chunks survives capture whole", async () => {
  // The three bytes of ▲ arrive in two pieces. Decoding each chunk on its own
  // would put a replacement character in the record.
  const text = 'event: content_block_delta\ndata: {"type":"content_block_delta","text":"▲"}\n\n';
  const bytes = Buffer.from(text, "utf8");
  const split = bytes.indexOf(Buffer.from("▲", "utf8")) + 1;
  const api = await tap.upstream({
    stream: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      chunks: [
        { gapMs: 0, text: bytes.subarray(0, split).toString("latin1"), encoding: "latin1" },
        { gapMs: 0, text: bytes.subarray(split).toString("latin1"), encoding: "latin1" },
      ],
    },
  });
  const { session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = (await snapshot()).requests[0]!;
  assert.deepEqual(captured.rawResponse, [text]);

  await quit(session);
});

test("a multi-turn conversation is held once, not once per request", async () => {
  // What a real session does: a large fixed preamble resent every time, a
  // history that only grows, and a cache breakpoint that moves to the end of
  // it each turn. The breakpoint is the part that would silently defeat
  // deduplication, so it is in the fixture rather than only in a unit test.
  const TURNS = 12;
  const system = [{ type: "text", text: `you are a tap. ${"s".repeat(300)}` }];
  const tools = Array.from({ length: 5 }, (_, index) => ({
    name: `tool_${index}`,
    description: "t".repeat(200),
    input_schema: { type: "object" },
  }));

  const history: { role: string; content: unknown; cache_control?: unknown }[] = [];
  const script = Array.from({ length: TURNS }, (_, turn) => {
    history.push({ role: "user", content: `ask ${turn}: ${"u".repeat(120)}` });
    // Yesterday's breakpoint goes, today's arrives. Same messages, spelled
    // differently every request.
    for (const message of history) delete message.cache_control;
    history[history.length - 1]!.cache_control = { type: "ephemeral" };
    const body = JSON.stringify({ model: "claude-opus-5", system, tools, messages: history });
    history.push({ role: "assistant", content: `answer ${turn}: ${"a".repeat(200)}` });
    return { path: "/v1/messages", body };
  });

  const api = await tap.upstream(responds("{}"));
  const { session, snapshot } = await tap.probe(script, api.baseUrl);

  const captured = await snapshot();
  assert.deepEqual(
    captured.requests.map((request) => payloadOf(captured, request)),
    script.map((step) => step.body),
    "every request still reconstructs to the bytes that were sent, breakpoints and all",
  );

  const { storage } = captured;
  // Twelve requests resend a history growing to twenty-three messages: 144
  // message units plus twelve each of system and tools.
  assert.equal(storage.referencedUnits, 168);
  assert.equal(
    storage.blobCount,
    25,
    "twenty-three distinct messages, one system block and one tools array — " +
      "a moved breakpoint is not a new message",
  );
  assert.equal(storage.deduplicationRatio, 6.72);

  const sent = script.reduce((total, step) => total + Buffer.byteLength(step.body), 0);
  assert.ok(
    storage.payloadSize < sent / 5,
    `held ${storage.payloadSize} bytes of the ${sent} forwarded`,
  );
  assert.equal(
    storage.recordSize,
    storage.payloadSize + storage.responseSize,
    "and the record's size is the whole record, responses included",
  );

  await quit(session);
});
