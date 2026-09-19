import { StringDecoder } from "node:string_decoder";
import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Ending, Entry, Record } from "./record.ts";
import { invokesSubagent } from "../agent/claude.ts";
import { readModel, readResponseModel, readSse, readToolUses, readUsage } from "./wire.ts";

/**
 * What the proxy tells capture as one request crosses it. The proxy calls
 * these and never waits for them: they exist so that capture can watch the
 * bytes going past, not so that it can stand in their way.
 *
 * Every method is total. A capture step that fails becomes a diagnostic in
 * here rather than an exception the proxy has to think about.
 */
export interface RequestCapture {
  requestChunk(chunk: Buffer): void;
  requestEnd(): void;
  responseStart(status: number, headers: NodeJS.Dict<string | string[]>): void;
  responseChunk(chunk: Buffer): void;
  /**
   * The request is over. `ending` says whether the upstream closed the
   * response or it was cut; only the first call counts, so the truthful
   * ending is the one the proxy saw first.
   */
  end(ending: Ending): void;
}

/** The whole of what the proxy knows about capture: one request at a time. */
export interface Capture {
  /** Total: a request capture could not be opened for is still forwarded. */
  begin(method: string, endpoint: string): RequestCapture;
}

/**
 * How much Tap will hold of any one thing it holds: a body it is reading, and
 * a response it is accumulating, each bounded on its own rather than against
 * a shared total. An unbounded hold is a way for a pathological request — or a
 * stream that never stops — to exhaust memory and take the agent's Tap session
 * down with it. Past the budget capture gives up and says so, keeping what
 * arrived before rather than dropping the lot.
 *
 * It bounds one request, not the record. The record holds payloads
 * content-addressed, so it grows with the conversation rather than with its
 * square, but it is not itself capped and evicts nothing yet.
 */
const BODY_BUDGET = 32 * 1024 * 1024;

/** Connects the bytes crossing the proxy to the record. */
export function createCapture(record: Record): Capture {
  return {
    begin(method, endpoint) {
      try {
        return watchRequest(record, record.begin(method, endpoint));
      } catch (error) {
        // Even opening an entry is capture work, and capture work that fails
        // is a diagnostic. The request still crosses Tap; it is only Tap's
        // note of it that is lost, and the diagnostic says so.
        record.diagnose(null, error);
        return IGNORED;
      }
    },
  };
}

/** A capture that records nothing, for a request capture could not open. */
const IGNORED: RequestCapture = {
  requestChunk: () => {},
  requestEnd: () => {},
  responseStart: () => {},
  responseChunk: () => {},
  end: () => {},
};

function watchRequest(record: Record, entry: Entry): RequestCapture {
  // An `other` request is recorded by method and path and not parsed at all:
  // Tap does not know its shape, and guessing at one would put invented facts
  // in the record. Its body is still held — the request Tap cannot read is
  // exactly the one worth having in full — it is simply not read.
  const parsed = entry.type !== "other";

  let requestBody: Body | null = openBody();
  let response: ResponseReader | null = null;
  /**
   * Capture failures are written down once per request. The alternative is a
   * malformed stream producing one diagnostic per line, which buries every
   * other diagnostic in the session — fail-open has to stay readable to be
   * worth anything.
   */
  let reported = false;
  /** The first ending wins, and nothing is read off the response after it. */
  let ended = false;
  /** How much of the response is held, against the budget for holding it. */
  let held = 0;
  let full = false;

  /**
   * Writes one piece of the response down, while there is room for it. Past
   * the budget this throws once and then stays quiet: the diagnostic says the
   * record of this response stops here, and repeating it every chunk would
   * bury every other diagnostic in the session.
   */
  const keep = (raw: string): void => {
    if (full) return;
    held += Buffer.byteLength(raw);
    if (held > BODY_BUDGET) {
      full = true;
      throw new Error(
        `response exceeded tap's ${BODY_BUDGET}-byte capture budget; ` +
          "what arrived before it is kept",
      );
    }
    entry.observeRawResponse(raw);
  };

  /** Runs a capture step, turning any failure of it into a diagnostic. */
  const attempt = (step: () => void): void => {
    try {
      step();
    } catch (error) {
      if (reported) return;
      reported = true;
      record.diagnose(entry.seq, error);
    }
  };

  return {
    requestChunk: (chunk) =>
      attempt(() => {
        if (requestBody === null) return;
        try {
          append(requestBody, chunk);
        } catch (error) {
          // Nothing is kept of a body that would not fit. Half a payload
          // presented as a payload is worse than the absence the diagnostic
          // explains.
          requestBody = null;
          throw error;
        }
      }),

    requestEnd: () =>
      attempt(() => {
        if (requestBody === null) return;
        const body = take(requestBody);
        requestBody = null;
        // Held before anything is read off it, so a body Tap cannot parse is
        // still a body Tap kept: the payload is the evidence, the model is a
        // convenience read off it.
        entry.observePayload(body);
        if (!parsed) return;
        const model = readModel(body);
        if (model !== null) entry.observeModel(model);
      }),

    responseStart: (status, headers) =>
      attempt(() => {
        entry.observeStatus(status);
        if (parsed) response = openResponse(entry, headers, attempt, keep);
      }),

    responseChunk: (chunk) => attempt(() => response?.push(chunk)),

    end: (ending) => {
      if (ended) return;
      ended = true;
      attempt(() => {
        response?.finish();
        response = null;
        requestBody = null;
      });
      // Outside the attempt: the request is over whether or not capture could
      // make sense of it, and a record that forgot to close an entry would
      // show an answered request as still in flight.
      entry.complete(ending);
    },
  };
}

/** A body held whole, under the budget, while a fact is read off it. */
interface Body {
  parts: Buffer[];
  size: number;
}

function openBody(): Body {
  return { parts: [], size: 0 };
}

function append(body: Body, chunk: Buffer): void {
  body.size += chunk.length;
  if (body.size > BODY_BUDGET) {
    body.parts.length = 0;
    throw new Error(`body exceeded tap's ${BODY_BUDGET}-byte capture budget`);
  }
  body.parts.push(chunk);
}

function take(body: Body): string {
  return Buffer.concat(body.parts).toString("utf8");
}

/**
 * Reads a response as it streams, without standing in its way. The bytes it is
 * given are a copy of what has already been forwarded to the agent.
 */
interface ResponseReader {
  push(chunk: Buffer): void;
  finish(): void;
}

function openResponse(
  entry: Entry,
  headers: NodeJS.Dict<string | string[]>,
  attempt: (step: () => void) => void,
  keep: (raw: string) => void,
): ResponseReader {
  const streamed = String(headers["content-type"] ?? "").includes("text/event-stream");
  const read = streamed ? openEvents(entry, keep) : openMessage(entry, keep);

  const decode = decoder(headers["content-encoding"]);
  if (decode === null) return read;

  // A compressed response is decoded on a copy, off the forwarding path: what
  // the agent receives is the bytes the upstream sent, encoding and all.
  // These fire after the proxy has moved on, so they carry their own guard:
  // the same one, so a decoding failure is written down exactly like any other
  // capture failure.
  decode.on("data", (chunk: Buffer) => attempt(() => read.push(chunk)));
  decode.on("end", () => attempt(() => read.finish()));
  decode.on("error", (error) =>
    attempt(() => {
      throw error;
    }),
  );

  return {
    push: (chunk) => void decode.write(chunk),
    // Finishing waits for the decoder to drain, so nothing is read from a
    // half-decoded body; the entry itself is completed by the caller either
    // way, so a decoder that never drains delays no one.
    finish: () => decode.end(),
  };
}

/** A response that arrives as server-sent events, read as they land. */
function openEvents(entry: Entry, keep: (raw: string) => void): ResponseReader {
  // Decoded across chunk boundaries: a character whose bytes arrive in two
  // pieces would otherwise become a replacement character in a record that
  // claims to be verbatim.
  const decode = new StringDecoder("utf8");
  let buffered = "";

  /**
   * Writes down what one pass found. Every step is attempted, so one
   * unreadable line does not cost the usage reported by the rest of the
   * stream, nor the events either side of it; the first failure is what
   * becomes the request's diagnostic.
   */
  const consume = (events: readonly string[], dataLines: readonly string[]): void => {
    let failure: unknown;
    let failed = false;
    const each = <T,>(values: readonly T[], step: (value: T) => void): void => {
      for (const value of values) {
        try {
          step(value);
        } catch (error) {
          if (failed) continue;
          failed = true;
          failure = error;
        }
      }
    };

    // The raw events are written down before anything is read off them: they
    // are the record where reading fails, so a stream Tap cannot parse must
    // not be a stream Tap did not keep.
    each(events, keep);
    each(dataLines, (line) => observe(entry, JSON.parse(line)));
    if (failed) throw failure;
  };

  return {
    push: (chunk) => {
      buffered += decode.write(chunk);
      if (buffered.length > BODY_BUDGET) {
        buffered = "";
        throw new Error(`event stream exceeded tap's ${BODY_BUDGET}-byte capture budget`);
      }
      const { events, dataLines, rest } = readSse(buffered);
      // The buffer advances first and unconditionally. Consuming may throw,
      // and a buffer that did not advance past a line Tap could not read would
      // grow for the rest of the response and be rescanned from the top on
      // every chunk.
      buffered = rest;
      consume(events, dataLines);
    },
    finish: () => {
      const half = buffered + decode.end();
      buffered = "";
      if (half.trim() === "") return;
      // The stream stopped with an event still open. What arrived is kept
      // exactly as it arrived: closing it off with the blank line the upstream
      // never sent would put invented bytes in a verbatim record. Its `data:`
      // lines are still read — the newline below frames them for reading and
      // never reaches the record.
      consume([half], readSse(`${half}\n`).dataLines);
    },
  };
}

/** A response that arrives as one JSON object: a message, or an error. */
function openMessage(entry: Entry, keep: (raw: string) => void): ResponseReader {
  const body = openBody();
  return {
    push: (chunk) => append(body, chunk),
    finish: () => {
      const text = take(body);
      // One document, one entry, written down before it is read: a provider
      // error is evidence exactly like an answer, and a body Tap cannot parse
      // is still a body Tap keeps.
      if (text !== "") keep(text);
      const json = text.trim();
      // An empty or non-JSON body is not something Tap failed at: a provider
      // error may be plain text, and a cut stream may be nothing at all.
      if (json === "" || !/^[[{]/.test(json)) return;
      observe(entry, JSON.parse(json));
    },
  };
}

function observe(entry: Entry, value: unknown): void {
  const usage = readUsage(value);
  if (usage !== null) entry.observeUsage(usage);
  const model = readResponseModel(value);
  if (model !== null) entry.observeModel(model);
  // Every tool-use block, each saying whether it is a subagent invocation.
  // Recording them all and marking some is what keeps the one inference here —
  // which tool name starts a subagent — from being able to cost the record a
  // fact the response plainly stated.
  for (const { id, name } of readToolUses(value)) {
    entry.observeToolUse({ id, tool: name, subagentInvocation: invokesSubagent(name) });
  }
}

/**
 * A decoder for a content coding, or null when the body is already plain.
 * An unrecognised coding throws, and so becomes a diagnostic: the honest
 * answer to a response Tap cannot read is to say so, not to show a request
 * with its usage silently missing.
 */
function decoder(encoding: string | string[] | undefined): Transform | null {
  const coding = String(encoding ?? "")
    .split(",")
    .pop()
    ?.trim()
    .toLowerCase();
  switch (coding) {
    case undefined:
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new Error(`response uses an unreadable content coding: ${coding}`);
  }
}
