import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createThreads } from "../src/record/threads.ts";
import { readSseFixture } from "./helpers/fake-upstream.ts";
import { killAllSessions } from "./helpers/run-tap.ts";
import { createProber, quit, responds } from "./helpers/session.ts";
import { payloadOf } from "./helpers/snapshot.ts";

/**
 * Thread attribution: telling one conversation lineage from another with
 * nothing on the wire that says so.
 *
 * The unit tests here work in message addresses, because that is what the
 * record hands the attributor — the addresses come from the blob store, so a
 * moved cache breakpoint has already stopped mattering by the time they get
 * here. The session tests then drive the whole of it, from a scripted
 * conversation through to what a reader of the snapshot sees.
 */

const tap = createProber("threads");
after(() => tap.dispose());
after(killAllSessions);

/** Stands in for the address of one message. Distinct strings, nothing more. */
const message = (name: string): string => `address-of-${name}`;

test("a request continuing a conversation is in the thread the conversation is", () => {
  const threads = createThreads();
  const [one, two, three] = [message("one"), message("two"), message("three")];

  assert.equal(threads.attribute(1, [one]), 1);
  assert.equal(threads.attribute(2, [one, two]), 1);
  assert.equal(
    threads.attribute(3, [one, two, three]),
    1,
    "the conversation grows and stays itself",
  );
  assert.deepEqual(threads.list(), [{ id: 1, main: true, firstSeq: 1 }]);
});

test("a request whose prefix has never been seen opens a thread of its own", () => {
  const threads = createThreads();
  const main = [message("prompt"), message("answer")];
  const other = [message("another opening")];

  assert.equal(threads.attribute(1, main), 1);
  assert.equal(threads.attribute(2, other), 2, "nothing shared, so nothing continued");
  assert.equal(threads.attribute(3, [...main, message("next")]), 1);
  assert.equal(threads.attribute(4, [...other, message("another answer")]), 2);

  assert.deepEqual(threads.list(), [
    { id: 1, main: true, firstSeq: 1 },
    { id: 2, main: false, firstSeq: 2 },
  ]);
});

test("the first thread of a session is the main one, and only the first", () => {
  const threads = createThreads();
  threads.attribute(1, [message("first")]);
  threads.attribute(2, [message("second")]);
  threads.attribute(3, [message("third")]);

  assert.deepEqual(
    threads.list().map((thread) => thread.main),
    [true, false, false],
  );
});

test("a thread is never told what it is, only which one it is", () => {
  const threads = createThreads();
  threads.attribute(1, [message("prompt")]);
  threads.attribute(2, [message("another opening")]);

  // The wire cannot tell a subagent from a `/clear`, a `--resume` or a
  // compaction, so nothing here may claim to have. A thread carries a number,
  // whether it was the first, and the request that opened it: no name, no
  // kind, and no parent.
  assert.deepEqual(Object.keys(threads.list()[1]!).sort(), ["firstSeq", "id", "main"]);
});

test("attribution does not depend on the order interleaved requests are assigned in", () => {
  // Two threads in flight at once arrive at the record interleaved, and the
  // one assigned first may be the longer. Attribution has to come out the same
  // either way, or a thread would fragment whenever a subagent's request
  // overtook the main conversation's.
  const conversation = [message("one"), message("two"), message("three")];

  const inOrder = createThreads();
  assert.equal(inOrder.attribute(1, conversation.slice(0, 1)), 1);
  assert.equal(inOrder.attribute(2, [message("elsewhere")]), 2);
  assert.equal(inOrder.attribute(3, conversation), 1);

  const overtaken = createThreads();
  assert.equal(overtaken.attribute(1, conversation), 1);
  assert.equal(overtaken.attribute(2, [message("elsewhere")]), 2);
  assert.equal(
    overtaken.attribute(3, conversation.slice(0, 1)),
    1,
    "the short request is the long one's prefix however late it is assigned",
  );
});

test("the longest prefix a request shares is the thread it belongs to", () => {
  // A shared opening is not a shared lineage: two threads can begin with the
  // same message and diverge, and a request that continues one of them belongs
  // to that one rather than to whichever was seen first.
  const threads = createThreads();
  const opening = message("identical opening");
  assert.equal(threads.attribute(1, [opening]), 1);
  assert.equal(threads.attribute(2, [opening, message("this way")]), 1);
  assert.equal(threads.attribute(3, [opening, message("that way")]), 1);
  assert.equal(
    threads.attribute(4, [opening, message("that way"), message("onwards")]),
    1,
    "shared prefixes are one thread; the wire does not say they are two",
  );
});

test("a request with no messages is attributed to nothing rather than to the main thread", () => {
  const threads = createThreads();
  assert.equal(threads.attribute(1, []), null, "there is no prefix to derive a lineage from");
  assert.deepEqual(threads.list(), [], "and nothing was opened by asking");

  assert.equal(threads.attribute(2, [message("prompt")]), 1);
  assert.equal(
    threads.attribute(3, []),
    null,
    "a request with no messages joins no thread, however many are open",
  );
});

test("history rewritten in place forks a thread, which is the honest answer", () => {
  // A compaction replaces the conversation with a summary of it. Nothing on
  // the wire distinguishes that from a fresh conversation, so it forks — an
  // accepted artefact rather than something to guess around.
  const threads = createThreads();
  assert.equal(threads.attribute(1, [message("one"), message("two"), message("three")]), 1);
  assert.equal(threads.attribute(2, [message("summary of one to three")]), 2);
  assert.deepEqual(
    threads.list().map((thread) => thread.firstSeq),
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
