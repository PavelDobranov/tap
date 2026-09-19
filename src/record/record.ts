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

/** The whole record as it stands. */
export interface Snapshot {
  readonly requests: readonly RecordedRequest[];
  readonly diagnostics: readonly Diagnostic[];
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
  observeStatus(status: number): void;
  /** Merges into what is already known; later events refine earlier ones. */
  observeUsage(usage: Usage): void;
  /** Ends the request, whether it was answered or not. Idempotent. */
  complete(): void;
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

  return {
    begin(method, endpoint) {
      const seq = requests.length + 1;
      const type = classify(method, endpoint);
      // The entry is in the record before a byte has been forwarded: a request
      // is visible when it starts, not when it finishes, which is the whole
      // point of watching one that is still in flight.
      const started = performance.now();
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
        observeStatus: (status) => amend({ status }),
        observeUsage: (usage) => amend({ usage: { ...request.usage, ...usage } }),
        complete: () => {
          if (request.completedAt !== null) return;
          amend({
            completedAt: new Date().toISOString(),
            durationMs: Math.round(performance.now() - started),
          });
        },
      };
    },

    diagnose(seq, detail) {
      diagnostics.push({ at: new Date().toISOString(), seq, detail: describe(detail) });
    },

    snapshot: () => ({ requests: [...requests], diagnostics: [...diagnostics] }),
  };
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
