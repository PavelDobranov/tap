import { contentHash, textAddress } from "./canonical.ts";
import { locate, type Span } from "./locate.ts";
import type { RequestType } from "./record.ts";

/**
 * A stored unit, content-addressed. Held uncompressed on purpose: these are
 * read continuously by a live UI, and paying decompression on every snapshot
 * to save memory that is capped anyway is the wrong trade.
 */
export interface Blob {
  /**
   * The unit's JSON, with its position-dependent annotations cut out — the
   * bytes as they arrived, not the canonical form. Canonical JSON decides the
   * address; only the bytes that arrived can be handed back.
   */
  readonly json: string;
  /** What holding it costs, in bytes. What eviction will weigh. */
  readonly size: number;
}

/** A cut annotation and where it goes back into a blob's JSON. */
export interface Annotation {
  /** The offset into the blob's JSON at which the text was cut. */
  readonly at: number;
  readonly text: string;
}

/** One unit of a skeleton, as the hash of its content plus what was cut. */
export interface UnitReference {
  /** The content hash of the unit, and its key in the blob map. */
  readonly blob: string;
  readonly annotations: readonly Annotation[];
}

/**
 * A part of a payload: either the text itself, or a reference standing in for
 * a unit that is held once in the blob map however many requests carry it.
 */
export type SkeletonPart = string | UnitReference;

/**
 * A captured payload with its units replaced by blob references. Joining the
 * parts back together — text as it stands, references filled from the blob
 * map and their annotations put back — gives the payload byte for byte.
 */
export type Skeleton = readonly SkeletonPart[];

export interface BlobMap {
  readonly [hash: string]: Blob;
}

/**
 * What holding one payload produced: the skeleton to reconstruct it from, and
 * the address of each of its messages, in wire order.
 *
 * The addresses come out of here rather than being computed again elsewhere
 * because they are the addresses with the annotations already cut. A message
 * whose only change between two requests is a moved cache breakpoint has one
 * address, and anything deriving conversation lineage from a second, naive
 * hash of the same text would see a fork every time Claude Code moved a
 * breakpoint.
 */
export interface Stored {
  readonly skeleton: Skeleton;
  /**
   * One address per element of `messages[]`, in order. Empty for a payload
   * with no messages in it — an `other` request, a `count_tokens` with none,
   * or a body that is not a JSON object at all.
   */
  readonly messageAddresses: readonly string[];
}

/** What deduplication is costing and saving. */
export interface PayloadStorage {
  /** Bytes of payload held: every blob, plus the text left in skeletons. */
  readonly payloadSize: number;
  readonly blobCount: number;
  /** Unit references across every skeleton, duplicates counted every time. */
  readonly referencedUnits: number;
  /**
   * Units per blob: 1 is no deduplication at all, and higher is better. This
   * is also where a unit that could not be addressed shows up — it stays in
   * its skeleton and is never referenced, so the ratio falls rather than the
   * saving being quietly overstated.
   */
  readonly deduplicationRatio: number;
}

/**
 * The content-addressed half of the record. Every `/v1/messages` request
 * resends the whole conversation, so holding payloads verbatim costs the
 * square of the conversation length; holding each unit once and referring to
 * it costs roughly the conversation.
 */
export interface Blobs {
  /**
   * Holds one payload and hands back its skeleton. The request's type decides
   * whether the payload is taken apart at all: an `other` request is one Tap
   * does not understand, and a body split on a guess at its shape is worse
   * than a body kept whole.
   *
   * Total: a payload that cannot be taken apart becomes a skeleton of one
   * literal part, which is the verbatim behaviour this replaced.
   */
  store(payload: string, type: RequestType): Stored;
  map(): BlobMap;
  storage(): PayloadStorage;
}

export function createBlobs(): Blobs {
  const blobs = new Map<string, Blob>();
  let blobBytes = 0;
  let literalBytes = 0;
  let referencedUnits = 0;

  /**
   * Holds one unit, and hands back its address and, where it could be held as
   * a reference, that reference.
   *
   * The reference is null when the unit cannot be one — the cut text is not
   * JSON, addressing it failed, or its address is already taken by bytes that
   * are not these. All three leave the unit in the skeleton verbatim, which
   * costs a duplicate and never costs fidelity. The address stands either way:
   * a unit that could not be deduplicated is still a unit whose content can be
   * compared with another request's, which is what thread attribution needs.
   */
  const intern = (payload: string, unit: Span, cuts: readonly Span[]): Interned => {
    const { json, annotations } = cut(payload, unit, cuts);

    let hash: string;
    try {
      hash = contentHash(JSON.parse(json));
    } catch {
      // Reading a unit is the one place the record touches content it did not
      // write, so it is the one place that has to survive anything: a body
      // that is not JSON after all, or nested past what a recursive walk of it
      // can take. Neither is a capture failure worth a diagnostic — the bytes
      // are kept either way, they are just kept twice. The bytes still get an
      // address, taken from the text rather than from a value nothing could
      // parse out of it.
      return { address: textAddress(json), reference: null };
    }

    const held = blobs.get(hash);
    if (held === undefined) {
      const detached = detach(json);
      blobs.set(hash, { json: detached.text, size: detached.size });
      blobBytes += detached.size;
    } else if (held.json !== json) {
      // Two spellings of one content: canonical JSON says they are the same
      // unit, but only one of them can be the bytes this blob hands back.
      // Addressing is an optimisation; the bytes are the record.
      return { address: hash, reference: null };
    }

    referencedUnits += 1;
    return { address: hash, reference: { blob: hash, annotations } };
  };

  return {
    store(payload, type) {
      const located = type === "other" ? null : locate(payload);
      if (located === null) {
        // Already its own string, so there is nothing to detach it from.
        literalBytes += Buffer.byteLength(payload);
        return { skeleton: [payload], messageAddresses: [] };
      }

      const messageAddresses: string[] = [];
      const parts: SkeletonPart[] = [];
      let literal = "";
      let cursor = 0;
      const flush = (): void => {
        if (literal === "") return;
        const detached = detach(literal);
        literalBytes += detached.size;
        parts.push(detached.text);
        literal = "";
      };

      for (const unit of located.units) {
        literal += payload.slice(cursor, unit.from);
        cursor = unit.to;
        const cuts = located.annotations.filter(
          (span) => span.from >= unit.from && span.to <= unit.to,
        );
        const { address, reference } = intern(payload, unit, cuts);
        if (unit.message) messageAddresses.push(address);
        if (reference === null) {
          literal += payload.slice(unit.from, unit.to);
          continue;
        }
        flush();
        parts.push(reference);
      }

      literal += payload.slice(cursor);
      flush();
      return { skeleton: parts, messageAddresses };
    },

    map: () => Object.fromEntries(blobs),

    storage: () => ({
      payloadSize: blobBytes + literalBytes,
      blobCount: blobs.size,
      referencedUnits,
      // Rounded, because this is a number a reader eyeballs rather than one
      // anything computes from.
      deduplicationRatio: blobs.size === 0 ? 0 : round(referencedUnits / blobs.size),
    }),
  };
}

/** A held unit: its address, and the reference standing in for it if it has one. */
interface Interned {
  readonly address: string;
  readonly reference: UnitReference | null;
}

/** One unit's text with its annotations cut out, and where each one was. */
function cut(
  payload: string,
  unit: Span,
  cuts: readonly Span[],
): { json: string; annotations: Annotation[] } {
  const annotations: Annotation[] = [];
  let json = "";
  let cursor = unit.from;
  for (const span of cuts) {
    json += payload.slice(cursor, span.from);
    // Recorded against the text that is left, which is the text the blob
    // holds: that is what the offset has to index on the way back.
    annotations.push({ at: json.length, text: payload.slice(span.from, span.to) });
    cursor = span.to;
  }
  return { json: json + payload.slice(cursor, unit.to), annotations };
}

/**
 * A payload as it arrived, from its skeleton and the blobs it refers to.
 *
 * The inverse of `store`, and exactly as documented an interface: a reader of
 * the snapshot — the UI, or anything else — reconstructs with this rule and
 * gets the bytes the upstream received.
 */
export function reconstruct(skeleton: Skeleton, blobs: BlobMap): string {
  return skeleton
    .map((part) => {
      if (typeof part === "string") return part;
      const blob = blobs[part.blob];
      if (blob === undefined) throw new Error(`the record no longer holds blob ${part.blob}`);
      return restore(blob.json, part.annotations);
    })
    .join("");
}

/** A blob's JSON with the annotations that were cut from it put back. */
function restore(json: string, annotations: readonly Annotation[]): string {
  let restored = "";
  let cursor = 0;
  for (const annotation of annotations) {
    restored += json.slice(cursor, annotation.at) + annotation.text;
    cursor = annotation.at;
  }
  return restored + json.slice(cursor);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A string that holds nothing but itself, and what holding it costs. */
interface Detached {
  readonly text: string;
  readonly size: number;
}

/**
 * The same text, holding nothing but itself.
 *
 * This is not a micro-optimisation, it is the whole scheme. A substring of a
 * large string in V8 is a *slice*: a pair of offsets that keeps the string it
 * was cut from alive. A blob taken straight out of a payload would therefore
 * pin the entire multi-megabyte payload it came from, so the record would go
 * on holding every request in full while reporting that it had deduplicated
 * them. Every string the record keeps is detached from the payload it was
 * read out of, and none of them outlive it.
 */
function detach(text: string): Detached {
  const bytes = Buffer.from(text, "utf8");
  return { text: bytes.toString("utf8"), size: bytes.byteLength };
}
