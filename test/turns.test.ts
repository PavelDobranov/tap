import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openUi, type Browser } from "./helpers/browser.ts";
import { createRecord, type Record as RecordHandle } from "../src/record/record.ts";
import { createTurns } from "../src/record/turns.ts";
import { startUi } from "../src/ui/server.ts";
import { freePort, killAllSessions } from "./helpers/run-tap.ts";
import { createProber, quit, responds } from "./helpers/session.ts";

/**
 * Turn derivation: reading the request list as prompts and the work each one
 * set off, from the shape of `messages[]` and nothing else.
 *
 * The unit tests work in final messages, because that is what the record
 * hands the deriver: a request begins a turn when its last message is from
 * the user and carries no tool result, and continues the current one
 * otherwise. The session and UI tests then drive the whole of it, from a
 * scripted conversation through to what a reader of the page sees.
 *
 * Every turn here is an *inference*. The tests say what the rule does, and
 * two of them say what it gets wrong — a compaction that looks turn-initial,
 * a queued prompt that does not — because those are the artefacts the rule is
 * accepted with rather than bugs to be guessed around.
 */

const tap = createProber("turns");
after(() => tap.dispose());
after(killAllSessions);

/** A user prompt: the shape that begins a turn. */
const prompt = (text: string): string => JSON.stringify({ role: "user", content: text });

/** A tool result going back to the model: the shape that continues one. */
const toolResult = (id: string): string =>
  JSON.stringify({
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
  });

const answer = (text: string): string =>
  JSON.stringify({ role: "assistant", content: [{ type: "text", text }] });

test("a user prompt with no tool result in it begins a turn, and the work after it continues", () => {
  const turns = createTurns();

  assert.equal(turns.attribute(1, prompt("read the file")), 1);
  assert.equal(turns.attribute(1, toolResult("toolu_read")), 1, "the tool loop is the same turn");
  assert.equal(turns.attribute(1, toolResult("toolu_grep")), 1);
  assert.equal(turns.attribute(1, prompt("now change it")), 2, "a fresh prompt is a fresh turn");
  assert.equal(turns.attribute(1, toolResult("toolu_edit")), 2);
});

test("a request whose last message is the assistant's continues the turn", () => {
  const turns = createTurns();

  assert.equal(turns.attribute(1, prompt("hello")), 1);
  assert.equal(
    turns.attribute(1, answer("thinking")),
    1,
    "only a user message can open a turn, whatever else is resent",
  );
});

test("ordinary user text is not confused for a tool result", () => {
  const turns = createTurns();

  assert.equal(turns.attribute(1, prompt("read the file")), 1);
  assert.equal(
    turns.attribute(1, prompt('what does "tool_result" mean?')),
    2,
    "a string content has no blocks in it, whatever the string says",
  );
  assert.equal(
    turns.attribute(1, JSON.stringify({ role: "user", content: [{ type: "text", text: "and now?" }] })),
    3,
    "a block array with no tool result in it is a prompt like any other",
  );
  assert.equal(
    turns.attribute(
      1,
      JSON.stringify({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "done" },
          { type: "text", text: "and while you are there" },
        ],
      }),
    ),
    3,
    "a prompt queued mid-loop carries a tool result, so the rule reads it as the same turn",
  );
});

test("turns are derived inside a thread and numbered in first-seen order there", () => {
  const turns = createTurns();

  assert.equal(turns.attribute(1, prompt("main one")), 1);
  assert.equal(turns.attribute(2, prompt("elsewhere one")), 1, "a thread counts from its own 1");
  assert.equal(turns.attribute(1, toolResult("toolu_main")), 1);
  assert.equal(turns.attribute(2, prompt("elsewhere two")), 2);
  assert.equal(turns.attribute(1, prompt("main two")), 2, "and is unmoved by the other thread");
  assert.equal(turns.attribute(3, toolResult("toolu_third")), 1);
});

test("a request with no thread to derive a turn in is left ungrouped", () => {
  const turns = createTurns();

  assert.equal(turns.attribute(null, prompt("nowhere")), null);
  assert.equal(turns.attribute(1, null), null, "and so is one with no final message");
  assert.equal(turns.attribute(1, prompt("somewhere")), 1, "neither of which opened a turn");
});

test("a thread that is first seen mid-loop starts at its first request rather than at a guess", () => {
  const turns = createTurns();

  assert.equal(
    turns.attribute(1, toolResult("toolu_first")),
    1,
    "the turn it continues was never captured, and inventing a boundary would not find it",
  );
  assert.equal(turns.attribute(1, toolResult("toolu_second")), 1);
  assert.equal(turns.attribute(1, prompt("next")), 2);
});

test("a final message that cannot be read as one continues the turn rather than opening one", () => {
  const turns = createTurns();

  assert.equal(turns.attribute(1, prompt("first")), 1);
  assert.equal(turns.attribute(1, "not json at all"), 1);
  assert.equal(turns.attribute(1, JSON.stringify("a string, not a message")), 1);
  assert.equal(turns.attribute(1, JSON.stringify({ content: "no role" })), 1);
});

/** The payload of one scripted request: a whole conversation, as the wire has it. */
const ask = (...messages: unknown[]): string =>
  JSON.stringify({ model: "claude-opus-5", messages: messages.map((message) => message) });

const user = (content: unknown): unknown => ({ role: "user", content });
const assistant = (content: unknown): unknown => ({ role: "assistant", content });
const result = (id: string): unknown => ({ type: "tool_result", tool_use_id: id, content: "ok" });

test("a session's turns are derived from the conversation and served in the snapshot", async () => {
  const api = await tap.upstream(responds("{}"));

  const first = user("read the file");
  const reading = assistant([{ type: "tool_use", id: "toolu_read", name: "Read", input: {} }]);
  const read = user([result("toolu_read")]);
  const answered = assistant("it says hello");
  const second = user("now change it");
  // A compaction: the conversation replaced by a summary of itself. It shares
  // no prefix, so it is a thread of its own, and its summary is a user
  // message, so it reads as that thread's first turn. Both are artefacts of
  // what the wire shows, and neither loses a request.
  const compacted = user("summary of the conversation so far");
  // A prompt queued while the tools were running arrives beside the result of
  // the tool that was running. The rule reads it as the same turn.
  const queued = user([result("toolu_grep"), { type: "text", text: "and check the tests" }]);

  const { session, snapshot } = await tap.probe(
    [
      { body: ask(first) },
      { body: ask(first, reading, read) },
      { body: ask(first, reading, read, answered, second) },
      { path: "/v1/messages/count_tokens", body: ask(first, reading, read, answered, second) },
      { body: ask(compacted) },
      { body: ask(compacted, assistant("on it"), queued) },
      { path: "/v1/models", body: "not json" },
    ],
    api.baseUrl,
  );

  const captured = await snapshot();
  assert.deepEqual(
    captured.requests.map((request) => [request.thread, request.turn]),
    [
      [1, 1],
      [1, 1],
      [1, 2],
      [1, null],
      [2, 1],
      [2, 1],
      [null, null],
    ],
    "turns inside a thread, and nothing invented for a request that is not one",
  );

  await quit(session);
});

test("two conversations in flight at once are each numbered in their own turns", async () => {
  const api = await tap.upstream(responds("{}"));

  // Each conversation opens with a prompt and then loops through its tools.
  // Whichever order the six requests reach the proxy in, neither may count
  // the other's prompt as one of its turns.
  const conversation = (name: string, length: number): string => {
    const messages: unknown[] = [user(`${name}: go`)];
    for (let step = 1; step < length; step += 1) {
      // The third request of each conversation is a second prompt rather than
      // another tool result, so each thread has to count a turn 2 of its own.
      messages.push(
        assistant([{ type: "tool_use", id: `toolu_${name}_${step}`, name: "Read", input: {} }]),
        step === 2 ? user(`${name}: and now this`) : user([result(`toolu_${name}_${step}`)]),
      );
    }
    return ask(...messages);
  };
  const names = ["alpha", "beta"];
  const script = [1, 2, 3].flatMap((length) =>
    names.map((name) => ({ body: conversation(name, length) })),
  );

  const { session, snapshot } = await tap.probe(script, api.baseUrl, "frozen", {
    concurrently: true,
  });

  const captured = await snapshot();
  assert.equal(captured.requests.length, script.length);
  const threads = [...new Set(captured.requests.map((request) => request.thread))];
  assert.equal(threads.length, 2, "two conversations, two lineages");
  for (const thread of threads) {
    assert.deepEqual(
      captured.requests
        .filter((request) => request.thread === thread)
        .map((request) => request.turn)
        .sort(),
      [1, 1, 2],
      `thread ${thread} counts its own turns, whatever the other thread did`,
    );
  }

  await quit(session);
});

/**
 * The UI half: a record served to a real page, driven through the page's own
 * script. Grouping is a reading aid, so what it is worth asserting on is
 * what a reader sees — the list, its dividers, and what is left when the aid
 * is switched off.
 */
interface Served {
  readonly record: RecordHandle;
  open(): Promise<Browser>;
  close(): Promise<void>;
}

async function serve(): Promise<Served> {
  const record = createRecord();
  const ui = await startUi(record, await freePort());
  const browsers: Browser[] = [];
  return {
    record,
    async open() {
      const browser = await openUi(ui.url);
      browsers.push(browser);
      await browser.until(
        "the live connection to open",
        () => browser.text("#connection") === "connected",
      );
      return browser;
    },
    async close() {
      for (const browser of browsers) browser.close();
      await ui.close();
    },
  };
}

/** One captured request, payload and all, as a scripted conversation makes it. */
function capture(record: RecordHandle, payload: string, path = "/v1/messages"): void {
  const entry = record.begin("POST", path);
  entry.observePayload(payload);
  entry.observeStatus(200);
  entry.complete("closed");
}

/**
 * The list as it reads down the page: a turn divider as its text, a request
 * as its sequence number, in the order they appear and skipping nothing that
 * is on screen.
 */
function listing(browser: Browser): (string | number)[] {
  return browser
    .all("#requests tr")
    .filter((row) => !row.hidden)
    .map((row) => (row.dataset.seq === undefined ? row.textContent : Number(row.dataset.seq)));
}

/** Just the requests, in the order the page has them. */
function order(browser: Browser): number[] {
  return browser.all("#requests tr[data-seq]").map((row) => Number(row.dataset.seq));
}

/** A conversation of one prompt and a tool loop after it, request by request. */
const toolLoop = (): string[] => [
  ask(user("read the file")),
  ask(user("read the file"), assistant("one moment"), user([result("toolu_read")])),
  ask(
    user("read the file"),
    assistant("one moment"),
    user([result("toolu_read")]),
    assistant("it says hello"),
    user("now change it"),
  ),
];

test("the request list groups into turns, labelled as inferred", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  for (const payload of toolLoop()) capture(served.record, payload);

  const browser = await served.open();
  await browser.until("the requests to arrive", () => order(browser).length === 3);

  assert.deepEqual(
    listing(browser).map((entry) => (typeof entry === "number" ? entry : "divider")),
    ["divider", 1, 2, "divider", 3],
    "a divider where a turn begins, and the requests of it under it in wire order",
  );
  const dividers = browser.all("#requests tr[data-turn]");
  assert.deepEqual(
    dividers.map((divider) => divider.dataset.turn),
    ["1", "2"],
    "one divider per turn, in the order the turns were first seen",
  );
  assert.match(dividers[0]!.textContent, /turn 1/i);
  assert.match(dividers[0]!.textContent, /2 requests/);
  assert.match(dividers[0]!.textContent, /inferred/i);
  assert.match(browser.text("#grouping-note"), /inferred/i);
});

test("a turn collapses and expands without reordering the list or losing a request", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  for (const payload of toolLoop()) capture(served.record, payload);

  const browser = await served.open();
  await browser.until("the requests to arrive", () => order(browser).length === 3);

  browser.click('#requests tr[data-turn="1"]');
  assert.deepEqual(
    listing(browser).filter((entry) => typeof entry === "number"),
    [3],
    "the turn's requests are folded away",
  );
  assert.deepEqual(order(browser), [1, 2, 3], "and every one of them is still here");
  assert.match(
    browser.find('#requests tr[data-turn="1"]').textContent,
    /2 requests/,
    "the divider goes on saying how many it is holding",
  );
  assert.match(browser.text("#counts"), /2 collapsed/);

  browser.click('#requests tr[data-turn="1"]');
  assert.deepEqual(
    listing(browser).filter((entry) => typeof entry === "number"),
    [1, 2, 3],
    "and expanding puts them back in wire order",
  );
  assert.doesNotMatch(browser.text("#counts"), /collapsed/);
});

test("a folded turn stays folded while its requests are still streaming", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const payloads = toolLoop();
  capture(served.record, payloads[0]!);
  const entry = served.record.begin("POST", "/v1/messages");
  entry.observePayload(payloads[1]!);

  const browser = await served.open();
  await browser.until("both requests", () => order(browser).length === 2);
  browser.click('#requests tr[data-turn="1"]');
  assert.deepEqual(
    listing(browser).filter((each) => typeof each === "number"),
    [],
    "the whole turn is folded away",
  );

  entry.observeRawResponse("data: still going\n\n");
  await browser.until(
    "the row to take the event",
    () => /receiving 1/.test(browser.find('#requests tr[data-seq="2"]').textContent),
  );
  assert.deepEqual(
    listing(browser).filter((each) => typeof each === "number"),
    [],
    "and a row that changed under it did not unfold it",
  );
});

test("grouping can be switched off to recover the flat wire-order list", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  for (const payload of toolLoop()) capture(served.record, payload);

  const browser = await served.open();
  await browser.until("the requests to arrive", () => order(browser).length === 3);
  browser.click('#requests tr[data-turn="1"]');

  browser.click("#turns");
  assert.deepEqual(listing(browser), [1, 2, 3], "no dividers, nothing folded, nothing reordered");
  assert.equal(browser.all("#requests tr[data-turn]").length, 0);

  browser.click("#turns");
  assert.deepEqual(
    listing(browser).filter((entry) => typeof entry === "number"),
    [1, 2, 3],
    "and switching it back on groups what is there rather than what was collapsed",
  );
});

test("a live request joins its turn as the payload arrives, and a reload derives the same", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const payloads = toolLoop();
  capture(served.record, payloads[0]!);

  const browser = await served.open();
  await browser.until("the first request", () => order(browser).length === 1);
  // Every request, so that one still in flight — which has no thread yet, and
  // so no turn — is on screen while it is being grouped.
  browser.click("#show-all");

  // A request is published the moment it starts, which is before its body has
  // been read: until then there is no conversation to derive a turn from, so
  // it sits ungrouped rather than being guessed at.
  const entry = served.record.begin("POST", "/v1/messages");
  await browser.until("the request in flight", () => order(browser).length === 2);
  assert.deepEqual(listing(browser).slice(-1), [2], "no turn to belong to yet");

  entry.observePayload(payloads[1]!);
  await browser.until(
    "the request to join the turn it continues",
    () => /2 requests/.test(browser.text('#requests tr[data-turn="1"]')),
  );
  const live = listing(browser);
  assert.deepEqual(live.slice(1), [1, 2]);

  const reloaded = await served.open();
  await reloaded.until("the reloaded page", () => order(reloaded).length === 2);
  reloaded.click("#show-all");
  assert.deepEqual(listing(reloaded), live, "the snapshot derives the grouping the stream did");
});

test("a request that is not conversation stays ungrouped between the turns", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const payloads = toolLoop();
  capture(served.record, payloads[0]!);
  capture(served.record, payloads[0]!, "/v1/messages/count_tokens");
  capture(served.record, '{"model":"claude-opus-5"}');
  capture(served.record, payloads[1]!);

  const browser = await served.open();
  await browser.until("the requests to arrive", () => order(browser).length === 4);
  browser.click("#show-all");

  const shown = listing(browser);
  assert.deepEqual(
    shown.filter((entry) => typeof entry === "number"),
    [1, 2, 3, 4],
    "wire order, whatever the grouping does around it",
  );
  const dividers = browser.all("#requests tr[data-turn]");
  assert.deepEqual(
    dividers.map((divider) => divider.dataset.turn),
    ["1", "1"],
    "the turn is picked up again after the requests that are not part of it",
  );
  assert.match(dividers[0]!.textContent, /1 request\b/);
  assert.doesNotMatch(dividers[0]!.textContent, /resumed/);
  assert.match(
    dividers[1]!.textContent,
    /1 request\b.*resumed/,
    "and each divider counts what is under it rather than claiming the whole turn",
  );

  // One turn, however many stretches of the list it is read in.
  browser.click('#requests tr[data-turn="1"]');
  assert.deepEqual(
    listing(browser).filter((entry) => typeof entry === "number"),
    [2, 3],
    "folding the turn folds all of it, and leaves what was never in it",
  );
});

test("filtering changes what is on screen and never which turn a request is in", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const payloads = toolLoop();
  capture(served.record, payloads[0]!);
  capture(served.record, payloads[0]!, "/v1/messages/count_tokens");
  capture(served.record, payloads[1]!);
  capture(served.record, payloads[2]!);

  const browser = await served.open();
  await browser.until("the requests to arrive", () => order(browser).length === 4);

  const turnOf = (seq: number): string | null => {
    const rows = browser.all("#requests tr");
    let turn: string | null = null;
    for (const row of rows) {
      if (row.dataset.turn !== undefined) turn = row.dataset.turn;
      if (row.dataset.seq === String(seq)) return turn;
    }
    return null;
  };

  assert.equal(turnOf(1), "1");
  assert.equal(turnOf(3), "1");
  assert.equal(turnOf(4), "2");

  browser.choose("#type", "any");
  assert.deepEqual(order(browser), [1, 2, 3, 4]);
  assert.equal(turnOf(1), "1", "the count_tokens request appearing changes nobody's turn");
  assert.equal(turnOf(4), "2");
});
