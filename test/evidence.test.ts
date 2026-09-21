import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openUi, type Browser } from "./helpers/browser.ts";
import { readSseFixture } from "./helpers/fake-upstream.ts";
import { freePort, killAllSessions } from "./helpers/run-tap.ts";
import { ask } from "./helpers/snapshot.ts";
import { createProber, quit } from "./helpers/session.ts";
import { createRecord, type Record } from "../src/record/record.ts";
import { startUi, type Ui } from "../src/ui/server.ts";

after(killAllSessions);

const prober = createProber("evidence");
after(() => prober.dispose());

/**
 * A payload with the shapes the evidence view has to hand back untouched: a
 * moved cache breakpoint, a message that is an array of blocks, and text with
 * escapes in it that a re-serialisation would spell differently.
 */
function capturedPayload(tail: string): string {
  return JSON.stringify({
    model: "claude-test",
    system: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: "first é\"quoted\"\n line" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: tail },
    ],
  });
}

interface Served {
  readonly record: Record;
  readonly ui: Ui;
  /** A browser with the page loaded and the opening snapshot applied. */
  open(): Promise<Browser>;
  close(): Promise<void>;
}

async function serve(options: { cap?: number } = {}): Promise<Served> {
  const record = createRecord(options.cap === undefined ? {} : { cap: options.cap });
  const ui = await startUi(record, await freePort());
  const browsers: Browser[] = [];
  return {
    record,
    ui,
    async open() {
      const browser = await openUi(ui.url);
      browsers.push(browser);
      await browser.until("the live connection to open", () => browser.text("#connection") === "connected");
      return browser;
    },
    async close() {
      for (const browser of browsers) browser.close();
      await ui.close();
    },
  };
}

/** The rows the list is showing, as sequence numbers in the order they appear. */
function shown(browser: Browser): number[] {
  return browser
    .all("#requests tr[data-seq]")
    .filter((row) => !row.hidden)
    .map((row) => Number(row.dataset.seq));
}

test("selecting a request shows the payload Tap captured, byte for byte", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const payload = capturedPayload("what did I just send?");

  const entry = served.record.begin("POST", "/v1/messages");
  entry.observePayload(payload);
  entry.observeModel("claude-test");

  const browser = await served.open();
  await browser.until("the request to arrive", () => shown(browser).length === 1);
  browser.click('#requests tr[data-seq="1"]');

  assert.equal(browser.text("#payload"), payload);
  assert.deepEqual(JSON.parse(browser.text("#payload")), JSON.parse(payload));
  assert.match(browser.text("#selected-title"), /1\b/);
  assert.equal(browser.find("#evidence-body").hidden, false);
});

test("raw response events append live, in arrival order, while the request is in flight", async (t) => {
  const served = await serve();
  t.after(() => served.close());

  const entry = served.record.begin("POST", "/v1/messages");
  entry.observePayload(capturedPayload("stream something"));
  const browser = await served.open();
  await browser.until("the request to arrive", () => shown(browser).length === 1);
  browser.click('#requests tr[data-seq="1"]');
  assert.equal(browser.text("#response"), "");
  assert.match(browser.text("#evidence-marks"), /in flight/i);

  const events = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"delta":{"text":"one"}}\n\n',
    'event: content_block_delta\ndata: {"delta":{"text":"two"}}\n\n',
  ];
  for (const event of events) {
    entry.observeRawResponse(event);
    // One at a time, so arrival order is a fact about the stream rather than
    // about how a burst happened to be rendered.
    await browser.until(
      `the event ending ${JSON.stringify(event.slice(-24))}`,
      () => browser.text("#response").endsWith(event),
    );
  }
  assert.equal(browser.text("#response"), events.join(""));

  entry.observeStatus(200);
  entry.complete("closed");
  await browser.until("the request to complete", () => !/in flight/i.test(browser.text("#evidence-marks")));
});

test("opening late rebuilds the same evidence, then continues with live events", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const payload = capturedPayload("before the viewer opened");

  const entry = served.record.begin("POST", "/v1/messages");
  entry.observePayload(payload);
  entry.observeRawResponse("data: before\n\n");

  // Every viewer here opens after the request started: one while it is still
  // in flight, one after it ended. Both must see the whole of it.
  const early = await served.open();
  await early.until("the request to arrive", () => shown(early).length === 1);
  early.click('#requests tr[data-seq="1"]');
  assert.equal(early.text("#payload"), payload);

  entry.observeRawResponse("data: after\n\n");
  await early.until("the later event", () => early.text("#response") === "data: before\n\ndata: after\n\n");
  entry.observeStatus(200);
  entry.complete("closed");

  const late = await served.open();
  await late.until("the request to arrive", () => shown(late).length === 1);
  late.click('#requests tr[data-seq="1"]');
  assert.equal(late.text("#payload"), early.text("#payload"));
  assert.equal(late.text("#response"), "data: before\n\ndata: after\n\n");
});

test("an evicted unit leaves a marked hole that cannot be read as the payload", async (t) => {
  // A cap of one byte evicts every blob the moment it is held, which is the
  // same hole a long session reaches by growing into its cap.
  const served = await serve({ cap: 1 });
  t.after(() => served.close());

  const entry = served.record.begin("POST", "/v1/messages");
  entry.observePayload(capturedPayload("this unit will not survive"));
  entry.complete("closed");

  const browser = await served.open();
  await browser.until("the request to arrive", () => shown(browser).length === 1);
  browser.click('#requests tr[data-seq="1"]');

  const text = browser.text("#payload");
  assert.match(text, /tap evicted this unit/);
  assert.match(text, /[0-9a-f]{64}/, "a hole must name the blob that is gone");
  assert.throws(() => JSON.parse(text), "a payload with a hole must not parse");
  // And the marks say so, rather than leaving a reader to notice the comment.
  assert.match(browser.text("#evidence-marks"), /evicted/i);
  assert.ok(browser.all("#payload mark").length > 0, "a hole must be marked in the page");
});

test("an interrupted response is marked and keeps every event that arrived", async () => {
  const fixture = readSseFixture("message-stream");
  const upstream = await prober.upstream({ stream: fixture, cut: true });
  const probed = await prober.probe([{}], upstream.baseUrl, "transcript");
  const browser = await openUi(probed.url);

  try {
    await browser.until("the live connection to open", () => browser.text("#connection") === "connected");
    await browser.until("the cut request to be marked", () =>
      /interrupted/i.test(browser.text('#requests tr[data-seq="1"]')));
    browser.click('#requests tr[data-seq="1"]');

    assert.match(browser.text("#evidence-marks"), /interrupted/i);
    // Everything the upstream managed to send is still there, in order.
    const sent = fixture.chunks.map((chunk) => chunk.text).join("");
    await browser.until("every event that arrived", () => browser.text("#response") === sent);
    assert.match(browser.text("#response-heading"), /\d+ events?/);
  } finally {
    browser.close();
    probed.session.type("exit");
    await quit(probed.session);
  }
});

test("filters default to the main thread and messages, and always say what they hid", async (t) => {
  const served = await serve();
  t.after(() => served.close());

  // One main-thread `messages` request, one `count_tokens`, one `other`, and
  // one that starts a second thread.
  const main = served.record.begin("POST", "/v1/messages");
  main.observePayload(capturedPayload("main thread"));
  main.complete("closed");
  // Counted against the same conversation, so it is the request type that
  // hides it rather than a lineage of its own.
  const counting = served.record.begin("POST", "/v1/messages/count_tokens");
  counting.observePayload(capturedPayload("main thread"));
  counting.complete("closed");
  const other = served.record.begin("GET", "/health");
  other.complete("closed");
  const second = served.record.begin("POST", "/v1/messages");
  second.observePayload(
    JSON.stringify({ model: "claude-test", messages: [{ role: "user", content: "a new lineage" }] }),
  );
  second.complete("closed");

  const browser = await served.open();
  await browser.until("all four requests", () => browser.all("#requests tr[data-seq]").length === 4);

  assert.equal(browser.find("#thread").value, "main");
  assert.equal(browser.find("#type").value, "messages");
  assert.deepEqual(shown(browser), [1]);
  assert.match(browser.text("#counts"), /4 requests/);
  assert.match(browser.text("#counts"), /3 hidden/);

  // One action, and everything the record holds is on screen.
  browser.click("#show-all");
  assert.deepEqual(shown(browser), [1, 2, 3, 4]);
  assert.match(browser.text("#counts"), /4 requests/);
  assert.doesNotMatch(browser.text("#counts"), /[1-9]\d* hidden/);

  // And the narrower filters are reachable rather than one-way.
  browser.choose("#type", "count_tokens");
  assert.deepEqual(shown(browser), [2]);
  browser.choose("#type", "other");
  assert.deepEqual(shown(browser), [3]);
  browser.choose("#type", "any");
  browser.choose("#thread", "2");
  assert.deepEqual(shown(browser), [4]);

  // A filter that matches nothing says so and still offers the way back.
  browser.choose("#type", "other");
  assert.deepEqual(shown(browser), []);
  assert.equal(browser.find("#empty").hidden, false);
  assert.match(browser.text("#counts"), /4 requests/);
  browser.click("#show-all");
  assert.deepEqual(shown(browser), [1, 2, 3, 4]);
});

test("a filtered-out request is still in client state and still inspectable", async (t) => {
  const served = await serve();
  t.after(() => served.close());

  const counting = served.record.begin("POST", "/v1/messages/count_tokens");
  const payload = JSON.stringify({ messages: [{ role: "user", content: "how long is this?" }] });
  counting.observePayload(payload);
  counting.observeRawResponse('{"input_tokens":7}');
  counting.complete("closed");

  const browser = await served.open();
  await browser.until("the request to arrive", () => browser.all("#requests tr[data-seq]").length === 1);
  // Hidden by the default filters, and not discarded: showing every request
  // brings it back with the evidence intact, with no reconnection.
  assert.deepEqual(shown(browser), []);
  browser.click("#show-all");
  browser.click('#requests tr[data-seq="1"]');
  assert.equal(browser.text("#payload"), payload);
  assert.equal(browser.text("#response"), '{"input_tokens":7}');
});

test("two viewers select and filter independently while watching one record", async (t) => {
  const served = await serve();
  t.after(() => served.close());

  const first = served.record.begin("POST", "/v1/messages");
  first.observePayload(capturedPayload("the first request"));
  first.complete("closed");
  const counting = served.record.begin("POST", "/v1/messages/count_tokens");
  counting.observePayload(JSON.stringify({ messages: [{ role: "user", content: "counted" }] }));
  counting.complete("closed");

  const reader = await served.open();
  const auditor = await served.open();
  for (const browser of [reader, auditor]) {
    await browser.until("both requests", () => browser.all("#requests tr[data-seq]").length === 2);
  }

  reader.click('#requests tr[data-seq="1"]');
  auditor.click("#show-all");
  auditor.choose("#type", "count_tokens");
  auditor.click('#requests tr[data-seq="2"]');

  assert.deepEqual(shown(reader), [1]);
  assert.deepEqual(shown(auditor), [2]);
  assert.match(reader.text("#payload"), /the first request/);
  assert.match(auditor.text("#payload"), /counted/);

  // And a live change reaches both, whatever each is looking at.
  const third = served.record.begin("POST", "/v1/messages");
  third.observePayload(capturedPayload("a third request"));
  for (const browser of [reader, auditor]) {
    await browser.until("the third request", () => browser.all("#requests tr[data-seq]").length === 3);
  }
  assert.deepEqual(shown(reader), [1, 3]);
  assert.deepEqual(shown(auditor), [2]);
  assert.match(reader.text("#payload"), /the first request/);
  assert.match(auditor.text("#payload"), /counted/);
});

test("the served page puts the list and the evidence side by side, and stacks them when narrow", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const url = new URL(served.ui.url);
  const fetched = async (route: string): Promise<string> => {
    const answer = await ask(Number(url.port), `${route}${url.search}`, { headers: { host: url.host } });
    assert.equal(answer.status, 200);
    return answer.body;
  };

  const browser = await served.open();
  assert.ok(browser.find("#request-list") !== null);
  assert.ok(browser.find("#evidence") !== null);

  const style = await fetched("/style.css");
  assert.match(style, /#panes\{[^}]*grid-template-columns:/, "the panes must sit side by side");
  assert.match(style, /@media\(max-width:\d+px\)\{[^}]*#panes\{grid-template-columns:1fr\}/,
    "and stack on a narrow screen");
  // The list is wider than a stacked pane, so it scrolls inside its own pane
  // rather than pushing the evidence beside it off the screen.
  assert.match(style, /#rows\{overflow:auto\}/);
  assert.match(style, /#panes>section\{min-width:0/, "a pane must be allowed to be narrow");
});

test("the evidence view renders the captured text and nothing semantic", async (t) => {
  const served = await serve();
  t.after(() => served.close());
  const url = new URL(served.ui.url);
  const app = await ask(Number(url.port), `/app.js${url.search}`, { headers: { host: url.host } });

  // The point of this view is to expose real shapes before anything is
  // designed to interpret them: no message rendering, and no diff.
  assert.doesNotMatch(app.body, /\bdiff\b/i);
  assert.doesNotMatch(app.body, /tool_result|tool_use|content_block/);

  const entry = served.record.begin("POST", "/v1/messages");
  const payload = capturedPayload("<script>not markup</script>");
  entry.observePayload(payload);
  const browser = await served.open();
  await browser.until("the request to arrive", () => shown(browser).length === 1);
  browser.click('#requests tr[data-seq="1"]');
  // Text, not markup: what the payload said is what the page shows.
  assert.equal(browser.text("#payload"), payload);
  assert.equal(browser.all("#payload script").length, 0);
});
