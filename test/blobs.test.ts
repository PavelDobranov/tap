import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import { canonicalJson } from "../src/record/canonical.ts";
import {
  createBlobs,
  evictedHole,
  reconstruct,
  reconstructParts,
  RECONSTRUCTION_SOURCE,
  type BlobMap,
  type ReconstructedPart,
  type Skeleton,
} from "../src/record/blobs.ts";
import type { RequestType } from "../src/record/record.ts";

/**
 * Unit tests for the deduplicating half of the record. Everything here is
 * about two properties that pull against each other: the record must hold far
 * less than it was shown, and what it hands back must be what it was shown,
 * byte for byte.
 */

/** Round-trips a payload through a fresh store, as a snapshot reader would. */
function roundTrip(payload: string, type: RequestType = "messages"): string {
  const blobs = createBlobs();
  const { skeleton } = blobs.store(payload, type, 1);
  return reconstruct(skeleton, blobs.map());
}

test("canonical json orders keys the same way whatever order they arrived in", () => {
  assert.equal(canonicalJson({ b: 1, a: 2, A: 3 }), '{"A":3,"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, A: 3, b: 1 }), '{"A":3,"a":2,"b":1}');
  assert.equal(
    canonicalJson({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] }),
    '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    "ordering reaches all the way down, and arrays keep their own order",
  );
});

test("a payload with nothing addressable in it is held as it arrived", () => {
  const other = "not json, not a shape tap knows";
  assert.equal(roundTrip(other, "other"), other);
  assert.equal(roundTrip('{"model":"claude-opus-5"}'), '{"model":"claude-opus-5"}');
});

test("system, tools and each message are addressed in their own right", () => {
  const blobs = createBlobs();
  const payload = JSON.stringify({
    model: "claude-opus-5",
    system: [{ type: "text", text: "you are a tap" }],
    tools: [{ name: "read", input_schema: {} }],
    messages: [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ],
  });

  const { skeleton } = blobs.store(payload, "messages", 1);
  const referenced = skeleton.filter((part) => typeof part !== "string");
  assert.equal(referenced.length, 4, "system, tools and two messages");
  assert.equal(Object.keys(blobs.map()).length, 4);
  assert.equal(reconstruct(skeleton, blobs.map()), payload);
});

test("the same conversation resent holds one blob per distinct unit, not per request", () => {
  const blobs = createBlobs();
  const system = [{ type: "text", text: "you are a tap" }];
  const tools = [{ name: "read", input_schema: { type: "object" } }];
  const messages: unknown[] = [];
  const skeletons: Skeleton[] = [];

  for (let turn = 0; turn < 10; turn += 1) {
    messages.push({ role: "user", content: `ask ${turn}` });
    messages.push({ role: "assistant", content: `answer ${turn}` });
    const payload = JSON.stringify({ model: "claude-opus-5", system, tools, messages });
    skeletons.push(blobs.store(payload, "messages", turn + 1).skeleton);
  }

  const storage = blobs.storage();
  // Ten requests resend a history growing to twenty messages: 110 message
  // units plus ten each of system and tools, against 22 distinct units.
  assert.equal(storage.referencedUnits, 130);
  assert.equal(storage.blobCount, 22);
  assert.ok(storage.deduplicationRatio > 5, `units per blob was ${storage.deduplicationRatio}`);
});

test("a moved cache_control breakpoint does not make a second blob of the same message", () => {
  const blobs = createBlobs();
  const plain = { role: "user" as const, content: [{ type: "text", text: "hello" }] };
  const marked = {
    role: "user" as const,
    content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
  };

  const first = blobs.store(JSON.stringify({ messages: [plain] }), "messages", 1);
  const second = blobs.store(JSON.stringify({ messages: [marked] }), "messages", 2);
  assert.deepEqual(
    first.messageAddresses,
    second.messageAddresses,
    "and the message addresses the record hands out are the same one",
  );

  assert.equal(Object.keys(blobs.map()).length, 1, "the breakpoint is not part of the content");
  assert.equal(reconstruct(first.skeleton, blobs.map()), JSON.stringify({ messages: [plain] }));
  assert.equal(
    reconstruct(second.skeleton, blobs.map()),
    JSON.stringify({ messages: [marked] }),
    "and the breakpoint comes back exactly where it was",
  );
});

test("a breakpoint is put back wherever it sat in the message", () => {
  const cases = [
    { cache_control: { type: "ephemeral" }, role: "user", content: "a" },
    { role: "user", cache_control: { type: "ephemeral" }, content: "a" },
    { role: "user", content: "a", cache_control: { type: "ephemeral" } },
    { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }] },
    { cache_control: { type: "ephemeral" } },
  ];

  const blobs = createBlobs();
  for (const message of cases) {
    const payload = JSON.stringify({ messages: [message] });
    assert.equal(
      reconstruct(blobs.store(payload, "messages", 1).skeleton, blobs.map()),
      payload,
      payload,
    );
  }
  assert.equal(
    Object.keys(blobs.map()).length,
    3,
    "the first three differ only in where the breakpoint sits, so they are one blob",
  );
});

test("cut then restore hands a unit back with every annotation where it was", () => {
  // The round trip, asserted on the rule itself rather than only through a
  // browser reading a snapshot. Two breakpoints in one unit is the case the
  // annotation cursor exists for: each offset indexes the text the blob
  // holds, so restoring the first must not displace the second.
  const message = {
    role: "user",
    content: [
      { type: "text", text: "first", cache_control: { type: "ephemeral" } },
      { type: "text", text: "second", cache_control: { type: "ephemeral" } },
    ],
  };
  const payload = JSON.stringify({ messages: [message] });

  const blobs = createBlobs();
  const { skeleton } = blobs.store(payload, "messages", 1);
  const unit = skeleton.find((part) => typeof part !== "string");
  assert.ok(unit !== undefined && typeof unit !== "string");
  assert.equal(unit.annotations.length, 2, "both breakpoints were cut");
  assert.ok(
    !blobs.map()[unit.blob]!.json.includes("cache_control"),
    "and the blob is the unit without them",
  );

  const parts = reconstructParts(skeleton, (hash) => blobs.map()[hash]);
  assert.deepEqual(parts.map((part) => part.hole), [false, false, false]);
  assert.equal(parts.map((part) => part.text).join(""), payload);
});

test("a reference whose blob has gone reconstructs to one marked hole", () => {
  const payload = JSON.stringify({ messages: [{ role: "user", content: "gone" }] });
  const blobs = createBlobs();
  const { skeleton } = blobs.store(payload, "messages", 1);
  const [evicted] = blobs.evictTo(0);
  assert.ok(evicted !== undefined);

  const parts = reconstructParts(skeleton, (hash) => blobs.map()[hash]);
  const holes = parts.filter((part) => part.hole);
  assert.equal(holes.length, 1);
  assert.equal(holes[0]!.text, evictedHole(evicted.blob));
  assert.throws(
    () => JSON.parse(parts.map((part) => part.text).join("")),
    "a payload with a hole must not parse as a shorter conversation",
  );
});

test("the rule the page receives is self-contained, and is the rule", () => {
  // The page runs this source in a browser, where the only names in scope are
  // the ones it brought with it. A reference from the rule to anything else in
  // this module would type-check, build, and fail only in a viewer, so the
  // source is run here in a context that holds nothing at all.
  const payload = JSON.stringify({
    messages: [{ role: "user", content: "a", cache_control: { type: "ephemeral" } }],
  });
  const blobs = createBlobs();
  const { skeleton } = blobs.store(payload, "messages", 1);

  const shipped = runInNewContext(
    `${RECONSTRUCTION_SOURCE}
    (skeleton, map) => JSON.stringify(reconstructParts(skeleton, (hash) => map[hash]));`,
    {},
  ) as (skeleton: Skeleton, map: BlobMap) => string;
  const here = (map: BlobMap): string =>
    JSON.stringify(reconstructParts(skeleton, (hash) => map[hash]));

  const held = blobs.map();
  assert.equal(shipped(skeleton, held), here(held));
  assert.equal(JSON.parse(shipped(skeleton, held)).map((part: ReconstructedPart) => part.text).join(""), payload);

  // And once the blob is gone, so that the hole a viewer shows comes from
  // here too rather than from a spelling the page kept.
  blobs.evictTo(0);
  const emptied = blobs.map();
  assert.equal(shipped(skeleton, emptied), here(emptied));
  assert.match(shipped(skeleton, emptied), /tap evicted this unit/);
});

test("reconstruction is byte-exact through whitespace, key order and escapes", () => {
  const payloads = [
    '{ "model" : "claude-opus-5" ,\n  "messages" : [ { "role" : "user" } ] }',
    '{"messages":[{"content":"h\\u00e9llo \\u25b2 \\"quoted\\" \\\\ \\n"}],"system":"s"}',
    '{"messages":[],"tools":[],"system":null}',
    '{"messages":[{"a":1.5e10,"b":-0.0,"c":[[],{},null,true]}]}',
    '{"messages":[{"role":"user","content":"cache_control is a string here"}]}',
    '{"cache_control":{"type":"ephemeral"},"messages":[{"role":"user"}]}',
    '{"messages":"not an array","tools":{"not":"an array either"}}',
  ];
  for (const payload of payloads) assert.equal(roundTrip(payload), payload, payload);
});

test("what the store holds is reported, and it is less than it was shown", () => {
  const blobs = createBlobs();
  const system = [{ type: "text", text: "s".repeat(4_000) }];
  const shown = [0, 1, 2].map((turn) => {
    const message = { role: "user", content: `ask ${turn}` };
    const payload = JSON.stringify({ system, messages: [message] });
    blobs.store(payload, "messages", turn + 1);
    return Buffer.byteLength(payload);
  });

  const storage = blobs.storage();
  assert.equal(storage.blobCount, 4, "one system block and three distinct messages");
  assert.equal(storage.referencedUnits, 6);
  assert.equal(storage.deduplicationRatio, 1.5);
  const total = shown.reduce((sum, size) => sum + size, 0);
  assert.ok(storage.payloadSize < total / 2, `held ${storage.payloadSize} of ${total}`);
});

test("a body that is not json at all is still held whole", () => {
  const torn = '{"model":"claude-opus-5",';
  const blobs = createBlobs();
  const { skeleton } = blobs.store(torn, "messages", 1);
  assert.deepEqual(skeleton, [torn], "unreadable is not the same as unrecorded");
  assert.equal(blobs.storage().blobCount, 0);
  assert.equal(reconstruct(skeleton, blobs.map()), torn);
});

test("reconstruction is byte-exact for arbitrary bodies of the right shape", () => {
  // Exactness is the one property that cannot be argued from examples: a
  // skeleton is only worth having if it never once hands back bytes that are
  // not the bytes that arrived. A seeded generator so a failure is repeatable.
  let seed = 0x5eed;
  const random = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;

  const scalar = (): unknown =>
    pick([null, true, false, 0, -1.5, 1e21, "", 'héllo "▲"\n\\', "cache_control"]);
  const value = (depth: number): unknown => {
    if (depth === 0 || random() < 0.4) return scalar();
    const length = Math.floor(random() * 4);
    if (random() < 0.5) return Array.from({ length }, () => value(depth - 1));
    const object: { [key: string]: unknown } = {};
    for (const key of ["type", "text", "a", "cache_control", "role"]) {
      if (random() < 0.5) object[key] = value(depth - 1);
    }
    return object;
  };
  /** Compact or spaced out: a body Tap did not serialise may be either. */
  const spell = (body: unknown): string =>
    random() < 0.5 ? JSON.stringify(body) : JSON.stringify(body, null, Math.floor(random() * 4));

  const blobs = createBlobs();
  for (let round = 0; round < 500; round += 1) {
    const payload = spell({
      model: "claude-opus-5",
      system: value(3),
      tools: value(3),
      messages: Array.from({ length: Math.floor(random() * 5) }, () => value(3)),
    });
    assert.equal(
      reconstruct(blobs.store(payload, "messages", round + 1).skeleton, blobs.map()),
      payload,
      payload,
    );
  }
  assert.ok(blobs.storage().referencedUnits > 1_000, "and the units really were addressed");
});

test("a stored blob does not keep the payload it was read out of alive", () => {
  // The scheme's whole point, and the one way it can fail silently. A
  // substring in V8 is a slice that pins the string it was cut from, so a
  // blob taken straight out of a payload holds that whole request — and the
  // record goes on holding every payload in full while reporting a
  // deduplication it is not getting. Measured, because no assertion about the
  // shape of a skeleton can see it.
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;

  const blobs = createBlobs();
  // A megabyte of system block, resent unchanged by every one of fifty
  // requests: one blob, and fifty megabytes of payload that must not survive
  // being read.
  const system = [{ type: "text", text: "s".repeat(1_000_000) }];
  for (let request = 0; request < 50; request += 1) {
    const message = { role: "user", content: `ask ${request}` };
    blobs.store(JSON.stringify({ system, messages: [message] }), "messages", request + 1);
  }

  const { payloadSize } = blobs.storage();
  assert.ok(payloadSize < 2 * 1024 * 1024, `the record says it holds ${payloadSize} bytes`);

  collect();
  const held = process.memoryUsage().heapUsed;
  assert.ok(
    held < 20 * 1024 * 1024,
    `50MB of payloads left ${(held / 1024 / 1024).toFixed(0)}MB on the heap, ` +
      `against the ${(payloadSize / 1024 / 1024).toFixed(1)}MB the record claims to hold`,
  );
});

test("a payload nested past what reading it can walk is kept whole, not lost", () => {
  // Reading a unit is the one place the record touches content it did not
  // write. A body nested deeply enough to exhaust a recursive walk must cost
  // deduplication and nothing else: the evidence is still the evidence.
  let deep = "1";
  for (let level = 0; level < 40_000; level += 1) deep = `[${deep}]`;
  const payload = `{"messages":[${deep}],"system":"fine"}`;

  const blobs = createBlobs();
  const { skeleton } = blobs.store(payload, "messages", 1);
  assert.equal(reconstruct(skeleton, blobs.map()), payload);
});
