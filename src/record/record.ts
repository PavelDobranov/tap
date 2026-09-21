import {
  createBlobs,
  type Blob,
  type BlobMap,
  type Eviction as BlobEviction,
  type PayloadStorage,
  type Skeleton,
  type Stored,
} from "./blobs.ts";
import type { AgentExit } from "../agent/run.ts";
import { createHash } from "node:crypto";

/**
 * Re-exported so that a reader of the record does not have to reach into the
 * agent layer for the shape the frozen lifecycle is stated in.
 */
export type { AgentExit };

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

/** One conversation lineage seen in a Tap session. */
export interface Thread {
  /** Numbered from 1, in order of first appearance. */
  readonly id: number;
  /**
   * Whether this is the first thread of the Tap session: the main thread, and
   * the default thing to read. It is the one thing about a thread the wire
   * does establish, because "first seen" needs no inference.
   */
  readonly main: boolean;
  /** The request that opened it. */
  readonly firstSeq: number;
}

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
   * thread began. See `createAttribution` below.
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
   * off. See `createAttribution` below for what it cannot see. A reader may
   * switch it off; nothing else in the record depends on it.
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
  /** Ends the live phase on the agent's exit; the first call wins. */
  freeze(exit: AgentExit): void;
  snapshot(): Snapshot;
}

export function createRecord(options: RecordOptions = {}): Record {
  const cap = options.cap ?? DEFAULT_RECORD_CAP;
  const requests: RecordedRequest[] = [];
  const diagnostics: Diagnostic[] = [];
  const evictions: Eviction[] = [];
  const blobs = createBlobs();
  const attribution = createAttribution();
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
          for (const [hash, blob] of Object.entries(stored.additions)) {
            publish({ type: "blob-added", hash, blob });
          }
          // Attributed from the payload that was held, so the prefix a thread
          // is derived from is the prefix the record can show.
          const { thread, turn } = attribution.attribute(seq, type, stored);
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

    freeze(exit) {
      if (lifecycle.phase === "frozen") return;
      lifecycle = { phase: "frozen", agent: exit };
      publish({ type: "frozen", agent: exit });
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
      threads: attribution.threads(),
      blobs: blobs.map(),
      storage: storage(),
      evictions: [...evictions],
      diagnostics: [...diagnostics],
    };
  }
}

/**
 * Thread and turn, derived from one payload as the record holds it.
 *
 * Claude Code sends no conversation identifier and no turn boundary. What it
 * does send is the whole conversation, every time: a request that continues a
 * conversation repeats every message of it and adds to the end. Both
 * derivations here read that one fact — lineage from the *prefix* a request
 * shares with the requests before it, and the boundary between turns from the
 * shape of the message on the end.
 *
 * Both are *inferences*, and neither claims more than the wire supports. Why
 * a new prefix appeared — a subagent, a `/clear`, a `--resume`, a compaction
 * that rewrote history — is not observable, so threads are numbered and never
 * named: confident misattribution is worse than none. Nor is it observable
 * whether a person was waiting for a request. A compaction rewrites history
 * into a user message and looks turn-initial; a prompt queued during a tool
 * loop arrives beside a tool result and does not. Both artefacts are accepted
 * rather than guessed around, because the guess that would fix either one
 * would have to claim something the wire cannot show. The cost of being wrong
 * is bounded by what a turn is allowed to do: group the request list for
 * reading. A misplaced boundary puts a divider in the wrong place, and can
 * never hide, drop or reorder a request.
 *
 * Derived here, at capture, and once — which is ADR-0008. The rule reads the
 * final message of a payload, and a reader of the record has that payload
 * only as a skeleton whose units may have been evicted: a turn derived in the
 * page would change when the record came under its cap, and two viewers of
 * one record could read different turns from it.
 */
interface Attribution {
  /**
   * Where a held payload's request belongs: the lineage it continues, and the
   * turn of that lineage it is part of.
   *
   * Total and synchronous, because it is called from the capture path.
   */
  attribute(seq: number, type: RequestType, stored: Stored): Attributed;
  /** The threads seen, in order of first appearance. */
  threads(): readonly Thread[];
}

/** What one payload said about where its request belongs. */
interface Attributed {
  readonly thread: number | null;
  readonly turn: number | null;
}

function createAttribution(): Attribution {
  /**
   * Every prefix seen, by its rolling address, and the thread that had it.
   *
   * Grows with the conversation rather than with the requests carrying it —
   * one entry per distinct message, at a fixed-size address each — and is not
   * evicted with the blobs. A thread whose prefixes were dropped would
   * fragment on its next request, which is a wrong answer where a heavier map
   * is only a heavier map.
   */
  const seen = new Map<string, number>();
  const threads: Thread[] = [];
  /** The turn each thread is in, by thread id. Numbered from 1 within it. */
  const currentTurn = new Map<number, number>();

  /** A lineage nothing seen so far continues, numbered as it is opened. */
  const openThread = (firstSeq: number): number => {
    const id = threads.length + 1;
    threads.push({ id, main: id === 1, firstSeq });
    return id;
  };

  /**
   * The lineage a request continues, given the addresses of its messages in
   * wire order, or a thread opened for it when it continues nothing.
   *
   * Null when there is no prefix to derive one from: a request with no
   * messages says nothing about lineage, and putting it in the main thread
   * because it had to go somewhere would be an assertion the wire does not
   * support.
   */
  const lineageOf = (seq: number, messages: readonly string[]): number | null => {
    if (messages.length === 0) return null;

    // Every prefix of this request is registered, not just the whole of it.
    // That is what makes attribution independent of the order requests are
    // assigned in: a long request assigned before the shorter one it
    // continues still leaves the shorter one's prefix behind, so two threads
    // interleaving on the wire attribute the same way either way round.
    const prefixes: string[] = [];
    let prefix = ROOT;
    let found: number | undefined;
    for (const message of messages) {
      prefix = extend(prefix, message);
      prefixes.push(prefix);
      // The longest match wins, and the last one to match is the longest: a
      // longer shared prefix is a more specific lineage.
      found = seen.get(prefix) ?? found;
    }

    const thread = found ?? openThread(seq);
    for (const each of prefixes) if (!seen.has(each)) seen.set(each, thread);
    return thread;
  };

  /** The turn `thread` is in, once this request has been counted into it. */
  const turnOf = (thread: number, finalMessage: string): number => {
    const current = currentTurn.get(thread);
    // A thread first seen mid-loop has no open turn to continue. Its first
    // request is turn 1 of it either way: the turn it really continues was
    // never captured, and numbering from 2 to leave a space for it would
    // assert a request Tap never saw.
    const turn = beginsTurn(finalMessage) ? (current ?? 0) + 1 : (current ?? 1);
    currentTurn.set(thread, turn);
    return turn;
  };

  return {
    attribute(seq, type, stored) {
      // The one ordering in here, and the reason the two derivations are one
      // call rather than two. Registering prefixes is safe in any order —
      // that is what `lineageOf` is built for — while counting turns is not:
      // it advances a counter per thread, so a turn counted before its thread
      // was settled, or against the thread that happened to come in last,
      // would be a silently wrong number. The thread is settled first, and
      // the turn is counted once, in the thread this request was just put in.
      const thread = lineageOf(seq, stored.messageAddresses);
      if (thread === null) return { thread, turn: null };

      // Only conversation is counted into turns, and the exclusion is
      // written here because here is where it is applied — one condition
      // rather than a rule in one module and its enforcement in another.
      // A `count_tokens` request repeats a thread's messages to ask what they
      // cost, which is not work the prompt set off, and giving it a turn
      // would inflate every count a divider shows; an `other` request is one
      // Tap cannot read at all. Both keep the thread their prefix earns them,
      // stay ungrouped, and leave the count where it was.
      if (type !== "messages") return { thread, turn: null };

      // Read here and dropped here. `finalMessage` is a slice of the payload
      // rather than a copy of it, so anything that held on to it would hold
      // the whole payload alive — the failure `detach` exists to stop. What
      // outlives this line is the number `turnOf` returns.
      const { finalMessage } = stored;
      // A payload with messages in it has a last one, so this stands for the
      // type rather than for a case the record can reach.
      if (finalMessage === null) return { thread, turn: null };
      return { thread, turn: turnOf(thread, finalMessage) };
    },

    threads: () => [...threads],
  };
}

/**
 * Whether a request's final message opens a turn: it is the user's, and
 * carries no tool result.
 *
 * Total, and false for anything it cannot read. A message that is not JSON,
 * or not an object, or has no role, says nothing about a boundary — and
 * false is the answer that costs least, because a missed boundary merges two
 * turns a reader can still see every request of, while an invented one
 * splits a tool loop that never paused.
 */
function beginsTurn(finalMessage: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(finalMessage);
  } catch {
    return false;
  }
  if (typeof message !== "object" || message === null) return false;
  const { role, content } = message as { role?: unknown; content?: unknown };
  if (role !== "user") return false;
  // A string content has no blocks in it, whatever the string says: the text
  // "tool_result" is a person talking about tool results, not one arriving.
  if (!Array.isArray(content)) return true;
  return !content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_result",
  );
}

/**
 * The prefix of no messages. Never registered against a thread — every
 * conversation has it, so matching on it would put every request in whichever
 * thread happened to arrive first.
 */
const ROOT = "";

/**
 * The address of a prefix, from the address of the prefix before it and the
 * address of the message that extends it.
 *
 * Rolled rather than accumulated so that extending a prefix costs one hash
 * however long the conversation is, and so that what is held per prefix is a
 * fixed-size string rather than the growing list of messages it stands for.
 */
function extend(prefix: string, message: string): string {
  return createHash("sha256").update(prefix).update(SEPARATOR).update(message).digest("hex");
}

/**
 * Between the two halves of a rolled address, so that the addresses being
 * joined cannot run together into the same bytes as a different pair would.
 */
const SEPARATOR = "\n";

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
