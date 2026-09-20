import {
  createBlobs,
  type Blob,
  type BlobMap,
  type Eviction as BlobEviction,
  type PayloadStorage,
  type Skeleton,
} from "./blobs.ts";
import { createThreads, type Thread } from "./threads.ts";
import { createTurns } from "./turns.ts";

/**
 * Re-exported so that the snapshot is one interface rather than two: a
 * reader that has the shape of a `Snapshot` has everything needed to
 * reconstruct a payload from it.
 */
export {
  evictedHole,
  reconstruct,
  type Annotation,
  type Blob,
  type BlobMap,
  type PayloadStorage,
  type Skeleton,
  type SkeletonPart,
  type UnitReference,
} from "./blobs.ts";

export type { Thread } from "./threads.ts";

/**
 * What a request was recognised as. Every request that reaches the proxy gets
 * one of these — `other` is a type, not a bin: nothing arriving is discarded,
 * because the one request that would have explained a bug is exactly the one a
 * capture-time filter would drop. Which types are *shown* is the UI's problem.
 */
export type RequestType = "messages" | "count_tokens" | "other";

/**
 * Token and cache accounting as the provider reported it, renamed into Tap's
 * own vocabulary. Every field is optional because different responses report
 * different subsets: a `count_tokens` answer has only an input count, and an
 * error has none at all.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * A tool-use block observed in a captured response.
 *
 * A *fact*, and the reason "subagent" is not a thread label: the response
 * itself said this tool use happened. Which later requests belong to a
 * subagent invocation is not said here, and is not inferred — the thread those
 * requests fall in is derived from their prefixes like any other, and is never
 * joined up to this.
 */
export interface ToolUse {
  /** The provider's id for the tool-use block. */
  readonly id: string;
  readonly tool: string;
  /**
   * Whether this tool use is a subagent invocation: the tool is one Claude
   * Code starts a subagent with. Every tool-use block is held either way, so a
   * tool Tap does not recognise is recorded and left unmarked rather than
   * dropped — a subagent invocation missing from the record would be read as a
   * subagent that never ran.
   */
  readonly subagentInvocation: boolean;
}

/** One request in the record, as the snapshot presents it. */
export interface RecordedRequest {
  /** Position in wire order, from 1. */
  readonly seq: number;
  readonly type: RequestType;
  /**
   * The conversation lineage this request continues, numbered from 1 in order
   * of first appearance, or null when it carried no messages to derive one
   * from. Thread 1 is the main thread.
   *
   * An inference, and a deliberately thin one: it says this request shares a
   * message prefix with the others in its thread, and nothing about why a
   * thread began. See `threads.ts`.
   */
  readonly thread: number | null;
  /**
   * The turn of that thread this request is part of, numbered from 1 in order
   * of first appearance within the thread, or null when it is not grouped
   * into one: a request with no thread, or one that is not conversation —
   * a `count_tokens` shares a thread's prefix without being work in its turn.
   *
   * An inference on top of an inference, and a weaker one than the thread it
   * sits in: it says this request looks like part of the work one prompt set
   * off. See `turns.ts` for what it cannot see. A reader may switch it off;
   * nothing else in the record depends on it.
   */
  readonly turn: number | null;
  readonly method: string;
  /** The request target as it arrived, path and query. */
  readonly endpoint: string;
  readonly model: string | null;
  /** The provider's status, or null while in flight and if it never answered. */
  readonly status: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly usage: Usage | null;
  /**
   * The request body as it crossed the proxy, held as a skeleton: the text
   * that arrived, with its units replaced by references into the snapshot's
   * blob map. Null when there was none to keep — nothing was sent, or capture
   * could not hold it.
   *
   * Reconstruction is exact. Joining the parts, filling each reference from
   * the blob map and putting its annotations back, gives the bytes the
   * upstream received: the evidence is worth nothing if it is a
   * re-serialisation of what Tap happened to parse. What is deduplicated is
   * the representation, never the fidelity.
   */
  readonly skeleton: Skeleton | null;
  /**
   * The response as it streamed from the upstream: one entry per event, in
   * arrival order, appended as each arrives rather than held back until the
   * response is finished — a response still in flight is readable as far as it
   * has got, and one that was cut leaves what it got rather than nothing.
   *
   * Kept for the whole Tap session for now. Once there is a reassembler (#5)
   * these are dropped as soon as the response has been reassembled, and stay
   * only where reassembly failed or the stream was cut.
   */
  readonly rawResponse: readonly string[];
  /**
   * Whether the response ended without the upstream closing it: the stream was
   * cut, or there was never an answer at all. What was captured up to that
   * point stands, and says so — a partial record read as a complete one is the
   * failure that produces a confident wrong conclusion.
   */
  readonly interrupted: boolean;
  /**
   * The tool-use blocks this request's response carried, in the order the
   * response opened them, each saying whether it is a subagent invocation.
   * A block appears once however many times the stream reports it.
   */
  readonly toolUses: readonly ToolUse[];
}

/**
 * A failure of capture itself. The visible half of fail-open: a capture
 * operation that threw is written down here and otherwise ignored, so a gap in
 * the record is never read as an absence of activity.
 */
export interface Diagnostic {
  readonly at: string;
  /** The request being captured when it happened, if there was one. */
  readonly seq: number | null;
  readonly detail: string;
}

/**
 * One blob dropped to keep the record under its cap, as an event in the
 * record. Eviction is never silent: a reader looking at a hole can find the
 * moment it was made and the request whose payload last needed it.
 */
export interface Eviction extends BlobEviction {
  readonly at: string;
}

/**
 * What the record is costing, what deduplication is saving it, and what the
 * cap has cost it.
 *
 * `recordSize` is the whole of it, payloads and responses both, because a
 * figure called the record's size that left out half the record is the kind
 * of number a reader acts on and should not have. `cap` is the ceiling it is
 * held under, so a reader can see how close the record is to evicting rather
 * than having to find out from the first hole.
 */
export interface Storage extends PayloadStorage {
  readonly recordSize: number;
  /** Bytes of response events held. Not deduplicated: every one is distinct. */
  readonly responseSize: number;
  /** The byte ceiling the record is kept under. */
  readonly cap: number;
}

export interface AgentExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export type Lifecycle =
  | { readonly phase: "live" }
  | { readonly phase: "frozen"; readonly agent: AgentExit };

/** The whole record as it stands. */
export interface Snapshot {
  /** Revision after the last change represented by this snapshot. */
  readonly revision: number;
  readonly lifecycle: Lifecycle;
  readonly requests: readonly RecordedRequest[];
  /**
   * The conversation lineages seen, in order of first appearance. The first is
   * the main thread; the rest are numbered and not otherwise named, because
   * the wire cannot say what they are.
   */
  readonly threads: readonly Thread[];
  /**
   * Every unit the record holds, once each, by content hash. This is where
   * the payloads actually are: a skeleton is only references into here.
   */
  readonly blobs: BlobMap;
  /** What holding them costs, and how much resending them is saving. */
  readonly storage: Storage;
  /**
   * The evictions the cap has forced, in the order they happened — the most
   * recent of them, because a list that grew with the session would be one
   * more unbounded hold in the part of Tap built to stop them. The exact
   * totals are in `storage`, which never forgets, so a list that has dropped
   * its own oldest entries understates the detail and never the fact.
   */
  readonly evictions: readonly Eviction[];

  readonly diagnostics: readonly Diagnostic[];
}

/**
 * How a request ended: the upstream closed its response, or it was cut — by
 * the upstream, by the agent giving up, or by never being answered at all.
 */
export type Ending = "closed" | "cut";

/** Row-sized facts that can change after a request starts. */
export interface RequestChange {
  readonly thread?: number | null;
  readonly turn?: number | null;
  /**
   * The payload, once it has been held. A request is published the moment it
   * starts, which is before its body has been read, so a viewer that only ever
   * sees deltas would have a row it could never show the evidence for. It
   * costs a live viewer no more than the snapshot it would get by reloading.
   */
  readonly skeleton?: Skeleton | null;
  readonly model?: string | null;
  readonly status?: number | null;
  readonly completedAt?: string | null;
  readonly durationMs?: number | null;
  readonly usage?: Usage | null;
  readonly interrupted?: boolean;
}

/** Small, bounded changes from which a live reader advances its snapshot. */
export type RecordEvent =
  | { readonly type: "request-start"; readonly request: RecordedRequest }
  | { readonly type: "request-change"; readonly seq: number; readonly changes: RequestChange }
  | { readonly type: "raw-response"; readonly seq: number; readonly event: string }
  | { readonly type: "blob-added"; readonly hash: string; readonly blob: Blob }
  | { readonly type: "blob-evicted"; readonly eviction: Eviction }
  | { readonly type: "diagnostic"; readonly diagnostic: Diagnostic }
  | { readonly type: "storage"; readonly storage: Storage }
  | { readonly type: "frozen"; readonly agent: AgentExit };

export interface RevisionedEvent {
  readonly revision: number;
  readonly event: RecordEvent;
}

export interface RecordView {
  readonly snapshot: Snapshot;
  close(): void;
}

/**
 * One request's place in the record, handed out when the request starts and
 * filled in as more is learned about it.
 *
 * Nothing here returns a promise. Capture is driven from the proxy's response
 * path, and a method that could be awaited is a method that could be awaited
 * in the wrong place.
 */
export interface Entry {
  readonly seq: number;
  readonly type: RequestType;
  observeModel(model: string): void;
  /**
   * Holds the request body as it was forwarded. The record takes it apart
   * into blobs and a skeleton; the caller hands over the bytes and is not
   * asked to know that.
   */
  observePayload(payload: string): void;
  /** Appends one response event, as it arrives. */
  observeRawResponse(event: string): void;
  observeStatus(status: number): void;
  /** Notes a tool-use block seen in the response. Ignores a repeat of one. */
  observeToolUse(toolUse: ToolUse): void;
  /** Merges into what is already known; later events refine earlier ones. */
  observeUsage(usage: Usage): void;
  /** Ends the request, whether it was answered or not. Idempotent. */
  complete(ending: Ending): void;
}

/**
 * How much of memory a Tap session will spend on what it has captured.
 *
 * Generous, and a ceiling rather than a target: the scripted eighty-turn
 * baseline holds under two megabytes, so a session reaches this only through
 * a pathological paste, a runaway tool result, or an afternoon of work — and
 * where it does, the cost of holding it must not be the agent's process.
 * Chosen to sit far above any ordinary session and far below a default Node
 * heap, so the cap is what stops the record growing rather than the
 * allocator.
 */
export const DEFAULT_RECORD_CAP = 256 * 1024 * 1024;

/**
 * How many eviction events the record keeps. The totals in `storage` are
 * exact however many evictions there have been; this bounds the detail beside
 * them, because a record capped precisely so that nothing in it grows without
 * limit cannot then grow without limit by writing down its own evictions.
 */
const EVICTION_EVENTS = 1_000;

/** What a record is built with. Everything here has a default. */
export interface RecordOptions {
  /**
   * The byte ceiling for the whole record, payloads and responses both.
   * Reaching it evicts blobs, oldest-first; it never refuses to capture.
   */
  readonly cap?: number;
}

/**
 * Everything Tap has captured in this Tap session, held in memory. There is no
 * store, no project and nothing on disk: the record is the whole of Tap's
 * state, and when Tap exits it is gone.
 */
export interface Record {
  /** Opens an entry for a request that has just arrived. */
  begin(method: string, endpoint: string): Entry;
  /**
   * Writes down a capture failure. Total, whatever it is handed: this is the
   * bottom of the fail-open path, so it has nowhere to report a failure of
   * its own.
   */
  diagnose(seq: number | null, detail: unknown): void;
  /** Atomically takes a snapshot and follows every later revision. */
  view(receive: (event: RevisionedEvent) => void): RecordView;
  freeze(outcome: AgentExit): void;
  snapshot(): Snapshot;
}

export function createRecord(options: RecordOptions = {}): Record {
  const cap = options.cap ?? DEFAULT_RECORD_CAP;
  const requests: RecordedRequest[] = [];
  const diagnostics: Diagnostic[] = [];
  const evictions: Eviction[] = [];
  const blobs = createBlobs();
  const threads = createThreads();
  const turns = createTurns();
  /** Counted as events arrive, so a snapshot never re-measures the record. */
  let responseSize = 0;
  let revision = 0;
  let lifecycle: Lifecycle = { phase: "live" };
  const viewers = new Set<(event: RevisionedEvent) => void>();

  const publish = (event: RecordEvent): void => {
    revision += 1;
    const revisioned = { revision, event };
    for (const receive of viewers) {
      try {
        receive(revisioned);
      } catch {
        // A disposable viewer is outside capture's failure boundary: it can
        // lose itself, never the request whose change it was being shown.
        viewers.delete(receive);
      }
    }
  };

  const storage = (): Storage => measure(blobs.storage(), responseSize, cap);

  /**
   * Brings the record back under its cap, if the last thing held took it
   * over. Blobs are the only thing there is to drop — the text left in
   * skeletons is what makes a request legible without them, and the response
   * events are what a cut stream leaves — so what is handed down is what is
   * left of the cap once the responses have taken their share.
   *
   * Cheap when there is nothing to do, which is almost always, because this
   * is on the path a request crosses: a comparison of two running totals.
   */
  const enforce = (): void => {
    const evicted = blobs.evictTo(Math.max(cap - responseSize, 0));
    if (evicted.length === 0) return;
    const at = new Date().toISOString();
    for (const eviction of evicted) {
      const recorded = { ...eviction, at };
      evictions.push(recorded);
      if (evictions.length > EVICTION_EVENTS) evictions.shift();
      publish({ type: "blob-evicted", eviction: recorded });
    }
  };

  return {
    begin(method, endpoint) {
      const seq = requests.length + 1;
      const type = classify(method, endpoint);
      // The entry is in the record before a byte has been forwarded: a request
      // is visible when it starts, not when it finishes, which is the whole
      // point of watching one that is still in flight.
      const started = performance.now();
      const rawResponse: string[] = [];
      const toolUses: ToolUse[] = [];
      let request: RecordedRequest = {
        seq,
        type,
        thread: null,
        turn: null,
        method,
        endpoint,
        model: null,
        status: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        durationMs: null,
        usage: null,
        skeleton: null,
        rawResponse,
        interrupted: false,
        toolUses,
      };
      requests.push(request);
      publish({ type: "request-start", request: copyRequest(request) });

      const amend = (
        changes: Partial<RecordedRequest>,
        visible: RequestChange | null,
      ): void => {
        request = { ...request, ...changes };
        requests[seq - 1] = request;
        if (visible !== null) publish({ type: "request-change", seq, changes: visible });
      };

      return {
        seq,
        type,
        observeModel: (model) => amend({ model }, { model }),
        observePayload: (payload) => {
          const stored = blobs.store(payload, type, seq);
          // Attributed from the payload that was held, so the prefix a thread
          // is derived from is the prefix the record can show.
          for (const [hash, blob] of Object.entries(stored.additions)) {
            publish({ type: "blob-added", hash, blob });
          }
          const thread = threads.attribute(seq, stored.messageAddresses);
          // Only conversation is grouped into turns. A `count_tokens` request
          // repeats a thread's messages to ask what they cost, which is not
          // work in the turn they belong to, and an `other` request is one Tap
          // cannot read at all: both stay ungrouped rather than being given an
          // invented turn, and neither advances the count.
          const turn = type === "messages" ? turns.attribute(thread, stored.finalMessage) : null;
          amend(
            { skeleton: stored.skeleton, thread, turn },
            { thread, turn, skeleton: stored.skeleton },
          );
          enforce();
          publish({ type: "storage", storage: storage() });
        },
        observeRawResponse: (event) => {
          responseSize += Buffer.byteLength(event);
          rawResponse.push(event);
          publish({ type: "raw-response", seq, event });
          enforce();
          publish({ type: "storage", storage: storage() });
        },
        observeStatus: (status) => amend({ status }, { status }),
        observeToolUse: (toolUse) => {
          // A `data:` line inside an event still open is read again on the
          // next pass, so the same block arrives more than once; the response
          // opened it once either way.
          if (toolUses.some((seen) => seen.id === toolUse.id)) return;
          toolUses.push(toolUse);
          amend({ toolUses: [...toolUses] }, null);
        },
        observeUsage: (usage) => {
          const observed = { ...request.usage, ...usage };
          amend({ usage: observed }, { usage: observed });
        },
        complete: (ending) => {
          if (request.completedAt !== null) return;
          const changes = {
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started),
            interrupted: ending === "cut",
          };
          amend(changes, changes);
        },
      };
    },

    diagnose(seq, detail) {
      const diagnostic = { at: new Date().toISOString(), seq, detail: describe(detail) };
      diagnostics.push(diagnostic);
      publish({ type: "diagnostic", diagnostic });
    },

    view(receive) {
      viewers.add(receive);
      const initial = takeSnapshot();
      return { snapshot: initial, close: () => viewers.delete(receive) };
    },

    freeze(outcome) {
      if (lifecycle.phase === "frozen") return;
      lifecycle = { phase: "frozen", agent: outcome };
      publish({ type: "frozen", agent: outcome });
    },

    // Copied down to the raw events, because a snapshot is the record as it
    // stands: an array still being appended to is a later record than the one
    // its reader was handed.
    snapshot: () => takeSnapshot(),
  };

  function takeSnapshot(): Snapshot {
    return {
      revision,
      lifecycle,
      requests: requests.map(copyRequest),
      threads: threads.list(),
      blobs: blobs.map(),
      storage: storage(),
      evictions: [...evictions],
      diagnostics: [...diagnostics],
    };
  }
}

function copyRequest(request: RecordedRequest): RecordedRequest {
  return {
    ...request,
    rawResponse: [...request.rawResponse],
    toolUses: [...request.toolUses],
  };
}

/** The payload figures with the responses beside them, as the snapshot shows. */
function measure(payload: PayloadStorage, responseSize: number, cap: number): Storage {
  return { ...payload, responseSize, cap, recordSize: payload.payloadSize + responseSize };
}

/** The Anthropic endpoints Tap understands. Everything else is `other`. */
const ROUTES: readonly (readonly [string, RequestType])[] = [
  ["/v1/messages/count_tokens", "count_tokens"],
  ["/v1/messages", "messages"],
];

/**
 * Types a request from its method and target alone. Nothing is parsed here,
 * which is what lets an `other` request be recorded at full fidelity without
 * Tap pretending to understand it.
 *
 * Only a POST can be one of the known endpoints: a GET to `/v1/messages` is
 * not a request Claude Code makes, and typing it as one would put a row in the
 * record claiming a model and a token count it will never have.
 */
function classify(method: string, endpoint: string): RequestType {
  if (method.toUpperCase() !== "POST") return "other";
  const path = endpoint.split("?", 1)[0] ?? "";
  return ROUTES.find(([route]) => path === route)?.[1] ?? "other";
}

/**
 * Whatever was thrown, as a line a reader can act on.
 *
 * Total, because it is the last step of recording a capture failure and a
 * value whose own `toString` throws must not be able to turn one diagnostic
 * into an exception on the agent's request path.
 */
function describe(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (typeof detail === "string") return detail;
  try {
    return String(detail);
  } catch {
    return "a capture failure that could not be described";
  }
}
