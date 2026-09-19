import { createBlobs, type BlobMap, type PayloadStorage, type Skeleton } from "./blobs.ts";

/**
 * Re-exported so that the snapshot is one interface rather than two: a
 * reader that has the shape of a `Snapshot` has everything needed to
 * reconstruct a payload from it.
 */
export {
  reconstruct,
  type Annotation,
  type Blob,
  type BlobMap,
  type PayloadStorage,
  type Skeleton,
  type SkeletonPart,
  type UnitReference,
} from "./blobs.ts";

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

/** One request in the record, as the snapshot presents it. */
export interface RecordedRequest {
  /** Position in wire order, from 1. */
  readonly seq: number;
  readonly type: RequestType;
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
 * What the record is costing, and what deduplication is saving it.
 *
 * `recordSize` is the whole of it, payloads and responses both, because a
 * figure called the record's size that left out half the record is the kind
 * of number a reader acts on and should not have.
 */
export interface Storage extends PayloadStorage {
  readonly recordSize: number;
  /** Bytes of response events held. Not deduplicated: every one is distinct. */
  readonly responseSize: number;
}

/** The whole record as it stands. */
export interface Snapshot {
  readonly requests: readonly RecordedRequest[];
  /**
   * Every unit the record holds, once each, by content hash. This is where
   * the payloads actually are: a skeleton is only references into here.
   */
  readonly blobs: BlobMap;
  /** What holding them costs, and how much resending them is saving. */
  readonly storage: Storage;

  readonly diagnostics: readonly Diagnostic[];
}

/**
 * How a request ended: the upstream closed its response, or it was cut — by
 * the upstream, by the agent giving up, or by never being answered at all.
 */
export type Ending = "closed" | "cut";

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
  /** Merges into what is already known; later events refine earlier ones. */
  observeUsage(usage: Usage): void;
  /** Ends the request, whether it was answered or not. Idempotent. */
  complete(ending: Ending): void;
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
  snapshot(): Snapshot;
}

export function createRecord(): Record {
  const requests: RecordedRequest[] = [];
  const diagnostics: Diagnostic[] = [];
  const blobs = createBlobs();
  /** Counted as events arrive, so a snapshot never re-measures the record. */
  let responseSize = 0;

  return {
    begin(method, endpoint) {
      const seq = requests.length + 1;
      const type = classify(method, endpoint);
      // The entry is in the record before a byte has been forwarded: a request
      // is visible when it starts, not when it finishes, which is the whole
      // point of watching one that is still in flight.
      const started = performance.now();
      const rawResponse: string[] = [];
      let request: RecordedRequest = {
        seq,
        type,
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
      };
      requests.push(request);

      const amend = (changes: Partial<RecordedRequest>): void => {
        request = { ...request, ...changes };
        requests[seq - 1] = request;
      };

      return {
        seq,
        type,
        observeModel: (model) => amend({ model }),
        observePayload: (payload) => amend({ skeleton: blobs.store(payload, type) }),
        observeRawResponse: (event) => {
          responseSize += Buffer.byteLength(event);
          rawResponse.push(event);
        },
        observeStatus: (status) => amend({ status }),
        observeUsage: (usage) => amend({ usage: { ...request.usage, ...usage } }),
        complete: (ending) => {
          if (request.completedAt !== null) return;
          amend({
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started),
            interrupted: ending === "cut",
          });
        },
      };
    },

    diagnose(seq, detail) {
      diagnostics.push({ at: new Date().toISOString(), seq, detail: describe(detail) });
    },

    // Copied down to the raw events, because a snapshot is the record as it
    // stands: an array still being appended to is a later record than the one
    // its reader was handed.
    snapshot: () => ({
      requests: requests.map((request) => ({ ...request, rawResponse: [...request.rawResponse] })),
      blobs: blobs.map(),
      storage: measure(blobs.storage(), responseSize),
      diagnostics: [...diagnostics],
    }),
  };
}

/** The payload figures with the responses beside them, as the snapshot shows. */
function measure(payload: PayloadStorage, responseSize: number): Storage {
  return { ...payload, responseSize, recordSize: payload.payloadSize + responseSize };
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
