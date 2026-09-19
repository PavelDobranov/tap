import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createBlobs, evictedHole, reconstruct } from "../src/record/blobs.ts";
import { createRecord, DEFAULT_RECORD_CAP } from "../src/record/record.ts";
import { killAllSessions } from "./helpers/run-tap.ts";
import { createProber, quit, responds } from "./helpers/session.ts";
import { payloadOf } from "./helpers/snapshot.ts";

/**
 * Memory is the scarce resource, so the record has a ceiling and drops the
 * oldest blobs to stay under it. Everything here is about the two halves of
 * that: the ceiling holds, and a reader can always tell that it did.
 */

const tap = createProber("eviction");
after(() => tap.dispose());
after(killAllSessions);

/** A payload carrying one message of a given size, unique to `mark`. */
function payload(mark: string, bytes: number): string {
  return JSON.stringify({
    model: "claude-opus-5",
    system: [{ type: "text", text: "you are a tap" }],
    messages: [{ role: "user", content: `${mark}:${"x".repeat(bytes)}` }],
  });
}

test("blobs are evicted oldest-first until the record is back under its cap", () => {
  const blobs = createBlobs();
  const stored = [0, 1, 2, 3].map((turn) =>
    blobs.store(payload(`ask ${turn}`, 1_000), "messages", turn + 1),
  );

  const before = blobs.storage().payloadSize;
  const evicted = blobs.evictTo(Math.floor(before / 2));

  assert.ok(evicted.length > 0, "something has to go to get under half the size");
  assert.ok(blobs.storage().payloadSize <= before / 2, "and enough has to go to get there");
  assert.equal(
    reconstruct(stored[3]!.skeleton, blobs.map()),
    payload("ask 3", 1_000),
    "the newest request is whole: eviction starts at the other end",
  );
  assert.ok(
    reconstruct(stored[0]!.skeleton, blobs.map()).includes(evictedHole(evicted[0]!.blob)),
    "and the oldest went first",
  );
});

test("age is the last request that referenced a blob, not the first", () => {
  const blobs = createBlobs();
  // A system block seen in request 1 and resent by request 3, against a
  // message carried only by request 2. Aged by first reference the system
  // block is the older of the two; aged by last reference it is the newer,
  // which is what matches a conversation that resends itself every turn.
  const shared = JSON.stringify({ type: "text", text: "s".repeat(1_000) });
  const spell = (message: string): string =>
    `{"system":[${shared}],"messages":[{"role":"user","content":"${message}"}]}`;

  blobs.store(spell("one"), "messages", 1);
  blobs.store(spell("two"), "messages", 2);
  const third = blobs.store(spell("one"), "messages", 3);

  const evicted = blobs.evictTo(blobs.storage().payloadSize - 1);
  assert.equal(evicted.length, 1, "one blob is enough to get back under");
  assert.equal(
    evicted[0]!.lastSeq,
    2,
    "the message only request 2 carried goes, though request 1's system block is older",
  );
  assert.ok(
    reconstruct(third.skeleton, blobs.map()).includes(shared),
    "and the block request 3 resent is still held",
  );
});

test("an oversized unit can go while the request that carried it survives", () => {
  const blobs = createBlobs();
  // One pathological tool result in request 1, and a request 2 that carries
  // everything else again. The result is the only thing old enough to go.
  const huge = "t".repeat(200_000);
  const head = '{"system":"small","messages":[';
  const after = '{"role":"user","content":"after"}';
  const { skeleton } = blobs.store(
    `${head}{"role":"user","content":"${huge}"},${after}]}`,
    "messages",
    1,
  );
  blobs.store(`${head}${after},{"role":"user","content":"more"}]}`, "messages", 2);

  const evicted = blobs.evictTo(20_000);
  assert.equal(evicted.length, 1, "one unit is over the cap on its own; the rest is not");

  const held = reconstruct(skeleton, blobs.map());
  assert.ok(!held.includes(huge), "the tool result itself is gone");
  assert.ok(held.includes(evictedHole(evicted[0]!.blob)), "and says so where it was");
  assert.ok(held.startsWith(head), "the shape of the request stands");
  assert.ok(held.includes(after), "and so does the rest of it");
});

test("a hole is a hole: never a silent gap, never a throw", () => {
  const blobs = createBlobs();
  const body = '{"messages":[{"role":"user","content":"gone"}]}';
  const { skeleton } = blobs.store(body, "messages", 1);
  const [evicted] = blobs.evictTo(0);

  const held = reconstruct(skeleton, blobs.map());
  assert.notEqual(held, body, "a gap that reconstructed to the original would be a lie");
  assert.throws(() => JSON.parse(held), "and one that still parsed would be read as whole");
  assert.ok(held.includes(evicted!.blob), "the hole names the address that is no longer there");
});

test("the record stays under its cap and says what it dropped", () => {
  const cap = 40_000;
  const record = createRecord({ cap });
  for (let seq = 0; seq < 20; seq += 1) {
    const entry = record.begin("POST", "/v1/messages");
    entry.observePayload(payload(`ask ${seq}`, 4_000));
    entry.complete("closed");
  }

  const { storage, evictions, requests } = record.snapshot();
  assert.equal(storage.cap, cap);
  assert.ok(storage.recordSize <= cap, `the record holds ${storage.recordSize} against ${cap}`);
  assert.ok(storage.evictedBlobs > 0, "which took evicting");
  assert.equal(
    storage.evictedBytes,
    evictions.reduce((sum, eviction) => sum + eviction.size, 0),
    "and every one of them is an event, not a silent drop",
  );
  assert.equal(storage.evictedBlobs, evictions.length);
  assert.equal(requests.length, 20, "no request was refused to stay under the cap");
});

test("response events count against the cap and press on the blobs", () => {
  const cap = 30_000;
  const record = createRecord({ cap });
  const entry = record.begin("POST", "/v1/messages");
  entry.observePayload(payload("ask", 20_000));
  assert.equal(record.snapshot().storage.evictedBlobs, 0, "one payload is inside the cap");

  for (let event = 0; event < 4; event += 1) entry.observeRawResponse("e".repeat(4_000));
  entry.complete("closed");

  const { storage } = record.snapshot();
  assert.ok(storage.evictedBlobs > 0, "a long enough response evicts the payload beside it");
  assert.ok(storage.recordSize <= cap, `the record holds ${storage.recordSize} against ${cap}`);
});

test("a record over its cap on responses alone shows it rather than hiding it", () => {
  // Eviction acts on blobs, and response events are not blobs: until they are
  // dropped on reassembly (#5) they are held whole. A session whose responses
  // alone exceed the cap therefore drops every blob it has and is still over,
  // which the storage block states — being over a stated cap is legible, and
  // evicting past the point where it helps would not make it less true.
  const cap = 10_000;
  const record = createRecord({ cap });
  const entry = record.begin("POST", "/v1/messages");
  entry.observePayload(payload("ask", 5_000));
  for (let event = 0; event < 10; event += 1) entry.observeRawResponse("e".repeat(4_000));

  const { storage } = record.snapshot();
  assert.equal(storage.blobCount, 0, "everything evictable went");
  assert.ok(storage.recordSize > cap, "and the record says it is over regardless");
  assert.equal(storage.responseSize, 40_000);
});

test("the default cap is documented and generous", () => {
  assert.equal(DEFAULT_RECORD_CAP, 256 * 1024 * 1024);
  const record = createRecord();
  assert.equal(record.snapshot().storage.cap, DEFAULT_RECORD_CAP);
});

test("a session under a cap evicts visibly and forwards everything regardless", async () => {
  const api = await tap.upstream(responds("{}"));
  const script = [0, 1, 2, 3, 4, 5, 6, 7].map((turn) => ({
    path: "/v1/messages",
    body: payload(`ask ${turn}`, 16_000),
  }));

  const { session, snapshot } = await tap.probe(script, api.baseUrl, "frozen", {
    tapArgs: ["--record-cap", "64KB"],
  });

  const captured = await snapshot();
  assert.equal(
    api.requests.map((request) => request.body).join("|"),
    script.map((step) => step.body).join("|"),
    "every request crossed the proxy untouched: eviction is not in the agent's way",
  );
  assert.deepEqual(captured.diagnostics, [], "and evicting is not a capture failure");

  assert.equal(captured.storage.cap, 64 * 1024);
  assert.ok(
    captured.storage.recordSize <= captured.storage.cap,
    `the record holds ${captured.storage.recordSize} against ${captured.storage.cap}`,
  );
  assert.ok(captured.storage.evictedBlobs > 0, "which took evicting");
  assert.ok(captured.evictions.length > 0, "and every eviction is in the record");

  const first = payloadOf(captured, captured.requests[0]!)!;
  assert.ok(first.includes("evicted"), "the oldest request reconstructs to a marked hole");
  assert.equal(
    payloadOf(captured, captured.requests[7]!),
    script[7]!.body,
    "while the newest is still byte-exact",
  );

  await quit(session);
});
