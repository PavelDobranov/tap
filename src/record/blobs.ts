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
  /** What holding it costs, in bytes. What eviction weighs. */
  readonly size: number;
}

/** One blob dropped to get the record back under its cap. */
export interface Eviction {
  /** The address that is no longer there, and is now a hole in a skeleton. */
  readonly blob: string;
  readonly size: number;
  /**
   * The last request that referenced it: this blob's age, and the reason it
   * was the one to go.
   */
  readonly lastSeq: number;
  /** Skeletons that referred to it, and so now reconstruct to a hole. */
  readonly references: number;
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
 * What holding one payload produced: the skeleton to reconstruct it from, the
 * address of each of its messages in wire order, and the last of those
 * messages as it arrived.
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
  /** Blobs first introduced by this payload, for live readers. */
  readonly additions: BlobMap;
  /**
   * One address per element of `messages[]`, in order. Empty for a payload
   * with no messages in it — an `other` request, a `count_tokens` with none,
   * or a body that is not a JSON object at all.
   */
  readonly messageAddresses: readonly string[];
  /**
   * The last element of `messages[]`, as the bytes that arrived, or null when
   * there was none. Handed back because turn derivation reads the shape of
   * it, and the text is here already: finding it again would mean scanning
   * the payload a second time, on the path a request crosses.
   *
   * Annotations are left in, unlike the addresses above. A moved cache
   * breakpoint cannot change whose message it is or whether a tool result is
   * in it, so cutting them here would cost a pass and buy nothing.
   *
   * To be read and dropped, never held: it is a slice of the payload, so
   * anything that keeps it keeps the whole payload alive — the failure
   * `detach` exists to stop.
   */
  readonly finalMessage: string | null;
}

/** What deduplication is costing and saving, and what eviction has dropped. */
export interface PayloadStorage {
  /** Bytes of payload held: every blob, plus the text left in skeletons. */
  readonly payloadSize: number;
  readonly blobCount: number;
  /**
   * References to blobs the record still holds, across every skeleton,
   * duplicates counted every time. An evicted blob takes its references with
   * it, so this counts what can still be read back rather than overstating
   * what a shrinking store is saving.
   */
  readonly referencedUnits: number;
  /**
   * Units per blob: 1 is no deduplication at all, and higher is better. This
   * is also where a unit that could not be addressed shows up — it stays in
   * its skeleton and is never referenced, so the ratio falls rather than the
   * saving being quietly overstated.
   */
  readonly deduplicationRatio: number;
  /** Blobs evicted since the session began. Never reset, never rolled up. */
  readonly evictedBlobs: number;
  readonly evictedBytes: number;
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
  store(payload: string, type: RequestType, seq: number): Stored;
  map(): BlobMap;
  storage(): PayloadStorage;
  /**
   * Drops blobs, oldest first, until what is held is at most `cap` bytes, and
   * hands back what went so the record can write it down.
   *
   * Oldest means least recently referenced. A blob's first reference says
   * nothing about whether it is still live: every `/v1/messages` request
   * resends the whole conversation, so the system block of a session in its
   * fiftieth turn was first seen in its first one, and evicting by first
   * reference would drop exactly the units every remaining request needs.
   *
   * The cap can be unreachable — the text left in skeletons is not evictable,
   * and neither are the response events held against the same ceiling — in
   * which case this drops every blob it has and stops there. Dropping more
   * than getting under it needs would be its own kind of dishonesty.
   */
  evictTo(cap: number): readonly Eviction[];
}

export function createBlobs(): Blobs {
  /**
   * Insertion-ordered, and re-inserted on every reference, so iterating it
   * walks the blobs in the order they were last referenced: least recently
   * first, which is the order eviction wants.
   */
  const blobs = new Map<string, Held>();
  let blobBytes = 0;
  let literalBytes = 0;
  let referencedUnits = 0;
  let evictedBlobs = 0;
  let evictedBytes = 0;
  /** Set only for the duration of one synchronous store operation. */
  let additions: { [hash: string]: Blob } = {};

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
  const intern = (payload: string, unit: Span, cuts: readonly Span[], seq: number): Interned => {
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
      blobs.set(hash, { json: detached.text, size: detached.size, lastSeq: seq, references: 1 });
      additions[hash] = { json: detached.text, size: detached.size };
      blobBytes += detached.size;
    } else if (held.json !== json) {
      // Two spellings of one content: canonical JSON says they are the same
      // unit, but only one of them can be the bytes this blob hands back.
      // Addressing is an optimisation; the bytes are the record.
      return { address: hash, reference: null };
    } else {
      // Referenced again, so it is the newest thing here: back to the end of
      // the queue eviction reads from the front of.
      held.lastSeq = seq;
      held.references += 1;
      blobs.delete(hash);
      blobs.set(hash, held);
    }

    referencedUnits += 1;
    return { address: hash, reference: { blob: hash, annotations } };
  };

  return {
    store(payload, type, seq) {
      additions = {};
      const located = type === "other" ? null : locate(payload);
      if (located === null) {
        // Already its own string, so there is nothing to detach it from.
        literalBytes += Buffer.byteLength(payload);
        return { skeleton: [payload], messageAddresses: [], finalMessage: null, additions };
      }

      const messageAddresses: string[] = [];
      let finalMessage: Span | null = null;
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
        const { address, reference } = intern(payload, unit, cuts, seq);
        if (unit.message) {
          messageAddresses.push(address);
          finalMessage = unit;
        }
        if (reference === null) {
          literal += payload.slice(unit.from, unit.to);
          continue;
        }
        flush();
        parts.push(reference);
      }

      literal += payload.slice(cursor);
      flush();
      return {
        skeleton: parts,
        messageAddresses,
        // Not detached: this is read once, by the caller, and dropped. It is
        // never held, so it cannot pin the payload it is a slice of.
        finalMessage: finalMessage === null ? null : payload.slice(finalMessage.from, finalMessage.to),
        additions,
      };
    },

    map: () =>
      Object.fromEntries(
        [...blobs].map(([hash, { json, size }]) => [hash, { json, size }] as const),
      ),

    storage: () => ({
      payloadSize: blobBytes + literalBytes,
      blobCount: blobs.size,
      referencedUnits,
      // Rounded, because this is a number a reader eyeballs rather than one
      // anything computes from.
      deduplicationRatio: blobs.size === 0 ? 0 : round(referencedUnits / blobs.size),
      evictedBlobs,
      evictedBytes,
    }),

    evictTo(cap) {
      const evicted: Eviction[] = [];
      for (const [blob, held] of blobs) {
        if (blobBytes + literalBytes <= cap) break;
        blobs.delete(blob);
        blobBytes -= held.size;
        referencedUnits -= held.references;
        evictedBlobs += 1;
        evictedBytes += held.size;
        evicted.push({
          blob,
          size: held.size,
          lastSeq: held.lastSeq,
          references: held.references,
        });
      }
      return evicted;
    },
  };
}

/** A blob as the store holds it: the snapshot sees only the first two fields. */
interface Held extends Blob {
  /** The last request to reference it. Its age, for eviction. */
  lastSeq: number;
  /**
   * How many skeleton references point at it, across the whole record. Eviction
   * takes them with the blob, so the deduplication figures describe what can
   * still be read back. A unit evicted and then resent comes back as a new
   * blob, and the skeletons that referred to the old one — which the new one
   * has the same address as, and so fills again — are not counted a second
   * time: the count understates the saving there rather than overstating it.
   */
  references: number;
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
 * One part of a reconstructed payload, and whether it is a hole rather than
 * bytes that arrived. A reader that only wants the payload joins the text; a
 * reader that shows it to someone marks the holes.
 */
export interface ReconstructedPart {
  readonly text: string;
  readonly hole: boolean;
}

/**
 * Where reconstruction reads a blob from. A function rather than the map
 * itself because the readers of a skeleton do not agree on how they hold
 * blobs — the record has an object keyed by address, a viewer has a `Map` it
 * fills as the record publishes additions — and the rule should not have to
 * care which.
 */
export type BlobLookup = (hash: string) => { readonly json: string } | undefined;

/**
 * What stands in a reconstructed payload where an evicted unit used to be.
 *
 * Part of the snapshot's documented interface, and deliberately not JSON: a
 * payload with a hole in it must fail to parse rather than parse into
 * something that looks like a shorter conversation than the one that
 * happened. It names the address so a reader can tie the hole to the eviction
 * event that made it.
 */
export function evictedHole(hash: string): string {
  return `/* tap evicted this unit to stay under its cap: ${hash} */`;
}

/**
 * A blob's JSON with the annotations that were cut from it put back.
 *
 * Each annotation's offset indexes the text the blob holds — the text with
 * every annotation already cut out — so the cursor is set to the recorded
 * offset and never advanced past the text just inserted. Advancing past it
 * would make each annotation displace the next one by its own length.
 */
function restoreAnnotations(json: string, annotations: readonly Annotation[]): string {
  let restored = "";
  let cursor = 0;
  for (const annotation of annotations) {
    restored += json.slice(cursor, annotation.at) + annotation.text;
    cursor = annotation.at;
  }
  return restored + json.slice(cursor);
}

/**
 * A payload as it arrived, in parts: the skeleton's text as it stands, and
 * each reference filled from the blob map with its annotations put back.
 *
 * The inverse of `store`, and exactly as documented an interface: a reader of
 * the snapshot — the UI, or anything else — reconstructs with this rule and
 * gets the bytes the upstream received.
 *
 * Except where a unit has been evicted, where it gets the bytes with a marked
 * hole in their place. That is the whole of the concession: never a throw,
 * which would lose the request along with the unit, and never a silent gap,
 * which is the failure that makes a reader draw a confident wrong conclusion.
 */
export function reconstructParts(skeleton: Skeleton, blobAt: BlobLookup): ReconstructedPart[] {
  return skeleton.map((part) => {
    if (typeof part === "string") return { text: part, hole: false };
    const held = blobAt(part.blob);
    if (held === undefined) return { text: evictedHole(part.blob), hole: true };
    return { text: restoreAnnotations(held.json, part.annotations), hole: false };
  });
}

/** The payload a skeleton stands for, joined, holes and all. */
export function reconstruct(skeleton: Skeleton, blobs: BlobMap): string {
  return reconstructParts(skeleton, (hash) => blobs[hash])
    .map((part) => part.text)
    .join("");
}

/**
 * The reconstruction rule as JavaScript source, for a reader that cannot
 * import it.
 *
 * The page runs in a browser with nothing fetched from anywhere else, so it
 * has to carry the rule rather than call it. It carries this one: the same
 * functions, shipped across the record→viewer seam instead of copied across
 * it, so the hole literal and the annotation cursor cannot drift.
 *
 * Declarations, so the order they are emitted in does not matter, and
 * self-contained, so the only names they need are each other's.
 */
export const RECONSTRUCTION_SOURCE: string = [
  evictedHole,
  restoreAnnotations,
  reconstructParts,
]
  .map((rule) => rule.toString())
  .join("\n\n");

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
