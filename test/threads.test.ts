import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createRecord, type Record as RecordHandle, type RecordedRequest } from "../src/record/record.ts";
import { readSseFixture } from "./helpers/fake-upstream.ts";
import { killAllSessions } from "./helpers/run-tap.ts";
import { createProber, quit, responds } from "./helpers/session.ts";
import { payloadOf } from "./helpers/snapshot.ts";

/**
 * Thread attribution: telling one conversation lineage from another with
 * nothing on the wire that says so.
 *
 * The unit tests here drive the record itself, because that is where a thread
 * is derived: a payload goes in and the row it produced says which lineage it
 * continued. Working in payloads rather than in addresses is also what makes
 * a moved cache breakpoint testable at all — the addresses a thread is
 * derived from are the record's, with annotations already cut. The session
 * tests then drive the whole of it, from a scripted conversation through to
 * what a reader of the snapshot sees.
 */

const tap = createProber("threads");
after(() => tap.dispose());
after(killAllSessions);

/** One request as the record saw it: a payload in, the row it made out. */
function capture(record: RecordHandle, payload: string, path = "/v1/messages"): RecordedRequest {
  const entry = record.begin("POST", path);
  entry.observePayload(payload);
  return record.snapshot().requests[entry.seq - 1]!;
}

/** The payload of one request: a whole conversation, as the wire has it. */
const ask = (...messages: unknown[]): string =>
  JSON.stringify({ model: "claude-opus-5", messages });

/** Stands in for one message. Distinct content, nothing more. */
const message = (name: string): unknown => ({ role: "user", content: name });

test("a request continuing a conversation is in the thread the conversation is", () => {
  const record = createRecord();
  const [one, two, three] = [message("one"), message("two"), message("three")];

  assert.equal(capture(record, ask(one)).thread, 1);
  assert.equal(capture(record, ask(one, two)).thread, 1);
  assert.equal(
    capture(record, ask(one, two, three)).thread,
    1,
    "the conversation grows and stays itself",
  );
  assert.deepEqual(record.snapshot().threads, [{ id: 1, main: true, firstSeq: 1 }]);
});

test("a request whose prefix has never been seen opens a thread of its own", () => {
  const record = createRecord();
  const main = [message("prompt"), message("answer")];
  const other = [message("another opening")];

  assert.equal(capture(record, ask(...main)).thread, 1);
  assert.equal(capture(record, ask(...other)).thread, 2, "nothing shared, so nothing continued");
  assert.equal(capture(record, ask(...main, message("next"))).thread, 1);
  assert.equal(capture(record, ask(...other, message("another answer"))).thread, 2);

  assert.deepEqual(record.snapshot().threads, [
    { id: 1, main: true, firstSeq: 1 },
    { id: 2, main: false, firstSeq: 2 },
  ]);
});

test("the first thread of a session is the main one, and only the first", () => {
  const record = createRecord();
  capture(record, ask(message("first")));
  capture(record, ask(message("second")));
  capture(record, ask(message("third")));

  assert.deepEqual(
    record.snapshot().threads.map((thread) => thread.main),
    [true, false, false],
  );
});

test("a thread is never told what it is, only which one it is", () => {
  const record = createRecord();
  capture(record, ask(message("prompt")));
  capture(record, ask(message("another opening")));

  // The wire cannot tell a subagent from a `/clear`, a `--resume` or a
  // compaction, so nothing here may claim to have. A thread carries a number,
  // whether it was the first, and the request that opened it: no name, no
  // kind, and no parent.
  assert.deepEqual(Object.keys(record.snapshot().threads[1]!).sort(), [
    "firstSeq",
    "id",
    "main",
  ]);
});

test("attribution does not depend on the order interleaved requests are assigned in", () => {
  // Two threads in flight at once arrive at the record interleaved, and the
  // one assigned first may be the longer. Attribution has to come out the same
  // either way, or a thread would fragment whenever a subagent's request
  // overtook the main conversation's.
  const conversation = [message("one"), message("two"), message("three")];

  const inOrder = createRecord();
  assert.equal(capture(inOrder, ask(...conversation.slice(0, 1))).thread, 1);
  assert.equal(capture(inOrder, ask(message("elsewhere"))).thread, 2);
  assert.equal(capture(inOrder, ask(...conversation)).thread, 1);

  const overtaken = createRecord();
  assert.equal(capture(overtaken, ask(...conversation)).thread, 1);
  assert.equal(capture(overtaken, ask(message("elsewhere"))).thread, 2);
  assert.equal(
    capture(overtaken, ask(...conversation.slice(0, 1))).thread,
    1,
    "the short request is the long one's prefix however late it is assigned",
  );
});

test("the longest prefix a request shares is the thread it belongs to", () => {
  // A shared opening is not a shared lineage: two threads can begin with the
  // same message and diverge, and a request that continues one of them belongs
  // to that one rather than to whichever was seen first.
  const record = createRecord();
  const opening = message("identical opening");
  assert.equal(capture(record, ask(opening)).thread, 1);
  assert.equal(capture(record, ask(opening, message("this way"))).thread, 1);
  assert.equal(capture(record, ask(opening, message("that way"))).thread, 1);
  assert.equal(
    capture(record, ask(opening, message("that way"), message("onwards"))).thread,
    1,
    "shared prefixes are one thread; the wire does not say they are two",
  );
});

test("a request with no messages is attributed to nothing rather than to the main thread", () => {
  const record = createRecord();
  assert.equal(
    capture(record, JSON.stringify({ model: "claude-opus-5" })).thread,
    null,
    "there is no prefix to derive a lineage from",
  );
  assert.deepEqual(record.snapshot().threads, [], "and nothing was opened by asking");

  assert.equal(capture(record, ask(message("prompt"))).thread, 1);
  assert.equal(
    capture(record, JSON.stringify({ model: "claude-opus-5" })).thread,
    null,
    "a request with no messages joins no thread, however many are open",
  );
});

test("a request Tap cannot read at all is attributed to nothing", () => {
  // An `other` request is never taken apart, so it has no messages to derive
  // a lineage from however much conversation is in its body.
  const record = createRecord();
  capture(record, ask(message("prompt")));
  assert.equal(capture(record, ask(message("prompt")), "/v1/models").thread, null);
  assert.deepEqual(record.snapshot().threads.length, 1, "and it opened nothing");
});

test("history rewritten in place forks a thread, which is the honest answer", () => {
  // A compaction replaces the conversation with a summary of it. Nothing on
  // the wire distinguishes that from a fresh conversation, so it forks — an
  // accepted artefact rather than something to guess around.
  const record = createRecord();
  assert.equal(
    capture(record, ask(message("one"), message("two"), message("three"))).thread,
    1,
  );
  assert.equal(capture(record, ask(message("summary of one to three"))).thread, 2);
  assert.deepEqual(
    record.snapshot().threads.map((thread) => thread.firstSeq),
    [1, 2],
  );
});

test("a conversation that forks into a second prefix is two threads in the snapshot", async () => {
  const api = await tap.upstream(responds("{}"));

  const ask = (...messages: unknown[]): string =>
    JSON.stringify({ model: "claude-opus-5", messages });
  const prompt = { role: "user", content: "what is in this file?" };
  const answer = { role: "assistant", content: "one moment" };
  // The same message, with a cache breakpoint moved onto it. A thread derived
  // from a naive hash of the text would fork here; one derived from the
  // record's addresses does not.
  const marked = {
    role: "user",
    content: "what is in this file?",
    cache_control: { type: "ephemeral" },
  };
  // Named for what the wire shows — a second lineage — and not for what it
  // might be. A test that called this one "the subagent" would be asserting
  // the thing thread attribution refuses to assert.
  const elsewhere = { role: "user", content: "read the file and report back" };

  const { session, snapshot } = await tap.probe(
    [
      { body: ask(prompt) },
      { body: ask(marked, answer) },
      { body: ask(elsewhere) },
      { body: ask(elsewhere, { role: "assistant", content: "it says hello" }) },
      { body: ask(prompt, answer, { role: "user", content: "thanks" }) },
      { path: "/v1/messages/count_tokens", body: ask(elsewhere) },
      { body: '{"model":"claude-opus-5"}' },
      { path: "/v1/models", body: "not json" },
    ],
    api.baseUrl,
  );

  const captured = await snapshot();
  assert.deepEqual(
    captured.requests.map((request) => request.thread),
    [1, 1, 2, 2, 1, 2, null, null],
    "two lineages, whichever endpoint carries them, and nothing for a request with no messages",
  );
  assert.deepEqual(captured.threads, [
    { id: 1, main: true, firstSeq: 1 },
    { id: 2, main: false, firstSeq: 3 },
  ]);

  await quit(session);
});

test("two conversations in flight at once stay two threads, however they interleave", async () => {
  const api = await tap.upstream(responds("{}"));

  // Six requests fired together, so the order they reach the proxy in is the
  // network's to decide. Whichever order that is, each conversation has to
  // come out as one thread: a subagent's request overtaking the main
  // conversation's must not fragment either of them.
  const ask = (name: string, turns: number): string => {
    const messages = [];
    for (let turn = 0; turn < turns; turn += 1) {
      messages.push({ role: turn % 2 === 0 ? "user" : "assistant", content: `${name} ${turn}` });
    }
    return JSON.stringify({ model: "claude-opus-5", messages });
  };
  const conversations = ["alpha", "beta"];
  const script = [1, 3, 5].flatMap((turns) =>
    conversations.map((name) => ({ body: ask(name, turns) })),
  );

  const { session, snapshot } = await tap.probe(script, api.baseUrl, "frozen", {
    concurrently: true,
  });

  const captured = await snapshot();
  assert.equal(captured.requests.length, script.length);
  assert.deepEqual(
    captured.threads.map((thread) => thread.main),
    [true, false],
    "exactly two lineages, one of them the first seen",
  );

  const threadsOf = (name: string): number[] => [
    ...new Set(
      captured.requests
        .filter((request) => payloadOf(captured, request)!.includes(name))
        .map((request) => request.thread!),
    ),
  ];
  const [alpha, beta] = conversations.map(threadsOf);
  assert.equal(alpha!.length, 1, `alpha was attributed to threads ${alpha}`);
  assert.equal(beta!.length, 1, `beta was attributed to threads ${beta}`);
  assert.notEqual(alpha![0], beta![0], "and the two conversations are not the same thread");

  await quit(session);
});

test("a subagent invocation is marked where a response shows one, and only there", async () => {
  const api = await tap.upstream(
    responds(
      JSON.stringify({
        type: "message",
        model: "claude-opus-5",
        content: [
          { type: "text", text: "I will hand this on" },
          { type: "tool_use", id: "toolu_subagent", name: "Task", input: { prompt: "go" } },
          { type: "tool_use", id: "toolu_read", name: "Read", input: { file: "a" } },
        ],
      }),
    ),
  );

  const { session, snapshot } = await tap.probe(
    [{ body: '{"model":"claude-opus-5","messages":[{"role":"user","content":"go"}]}' }],
    api.baseUrl,
  );

  const captured = await snapshot();
  assert.deepEqual(
    captured.requests[0]!.toolUses,
    [
      { id: "toolu_subagent", tool: "Task", subagentInvocation: true },
      { id: "toolu_read", tool: "Read", subagentInvocation: false },
    ],
    "both blocks are facts the response stated; only one of them is a subagent invocation",
  );
  assert.deepEqual(
    captured.requests[0]!.thread,
    1,
    "and the request that carried it is attributed like any other",
  );

  await quit(session);
});

test("a tool use streamed across chunk boundaries is recorded once", async () => {
  // The fixture cuts between the `data:` line opening the tool use and the
  // blank line closing its event, so the line is read twice — once for the
  // live view, once when the event completes. The response opened it once.
  const api = await tap.upstream({ stream: readSseFixture("tool-use-stream") });
  const { session, snapshot } = await tap.probe([{}], api.baseUrl);

  const captured = await snapshot();
  assert.deepEqual(captured.requests[0]!.toolUses, [
    { id: "toolu_fixture_task", tool: "Task", subagentInvocation: true },
    { id: "toolu_fixture_read", tool: "Read", subagentInvocation: false },
  ]);

  await quit(session);
});
