import type { Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Entry, Record } from "./record.ts";
import { readModel, readResponseModel, readSseData, readUsage } from "./wire.ts";

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
  /** The request is over, answered or not. Safe to call more than once. */
  end(): void;
}

/** The whole of what the proxy knows about capture: one request at a time. */
export interface Capture {
  /** Total: a request capture could not be opened for is still forwarded. */
  begin(method: string, endpoint: string): RequestCapture;
}

/**
 * How much of one body Tap will hold while reading a fact off it. Bodies are
 * not kept — they are parsed and dropped — but they are held whole for the
 * length of one request, and an unbounded hold is a way for a pathological
 * request to exhaust memory and take the agent's session down with it. Past
 * the budget capture gives up and says so.
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
  // in the record.
  const parsed = entry.type !== "other";

  let requestBody: Body | null = parsed ? openBody() : null;
  let response: ResponseReader | null = null;
  /**
   * Capture failures are written down once per request. The alternative is a
   * malformed stream producing one diagnostic per line, which buries every
   * other diagnostic in the session — fail-open has to stay readable to be
   * worth anything.
   */
  let reported = false;

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
        if (requestBody !== null) append(requestBody, chunk);
      }),

    requestEnd: () =>
      attempt(() => {
        if (requestBody === null) return;
        const body = take(requestBody);
        requestBody = null;
        const model = readModel(body);
        if (model !== null) entry.observeModel(model);
      }),

    responseStart: (status, headers) =>
      attempt(() => {
        entry.observeStatus(status);
        if (parsed) response = openResponse(entry, headers, attempt);
      }),

    responseChunk: (chunk) => attempt(() => response?.push(chunk)),

    end: () => {
      attempt(() => {
        response?.finish();
        response = null;
        requestBody = null;
      });
      // Outside the attempt: the request is over whether or not capture could
      // make sense of it, and a record that forgot to close an entry would
      // show an answered request as still in flight.
      entry.complete();
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
): ResponseReader {
  const streamed = String(headers["content-type"] ?? "").includes("text/event-stream");
  const read = streamed ? openEvents(entry) : openMessage(entry);

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
function openEvents(entry: Entry): ResponseReader {
  let buffered = "";

  const consume = (): void => {
    const { payloads, rest } = readSseData(buffered);
    // The buffer advances first and unconditionally. Everything below may
    // throw, and a buffer that did not advance past a line Tap could not read
    // would grow for the rest of the response and be rescanned from the top
    // on every chunk.
    buffered = rest;

    // Every payload is attempted, so one unreadable line does not cost the
    // usage reported by the rest of the stream; the first failure is what
    // becomes the request's diagnostic.
    let failure: unknown;
    let failed = false;
    for (const payload of payloads) {
      try {
        observe(entry, JSON.parse(payload));
      } catch (error) {
        if (failed) continue;
        failed = true;
        failure = error;
      }
    }
    if (failed) throw failure;
  };

  return {
    push: (chunk) => {
      buffered += chunk.toString("utf8");
      if (buffered.length > BODY_BUDGET) {
        buffered = "";
        throw new Error(`event stream exceeded tap's ${BODY_BUDGET}-byte capture budget`);
      }
      consume();
    },
    finish: () => {
      buffered += "\n";
      consume();
    },
  };
}

/** A response that arrives as one JSON object: a message, or an error. */
function openMessage(entry: Entry): ResponseReader {
  const body = openBody();
  return {
    push: (chunk) => append(body, chunk),
    finish: () => {
      const text = take(body).trim();
      // An empty or non-JSON body is not something Tap failed at: a provider
      // error may be plain text, and a cut stream may be nothing at all.
      if (text === "" || !/^[[{]/.test(text)) return;
      observe(entry, JSON.parse(text));
    },
  };
}

function observe(entry: Entry, value: unknown): void {
  const usage = readUsage(value);
  if (usage !== null) entry.observeUsage(usage);
  const model = readResponseModel(value);
  if (model !== null) entry.observeModel(model);
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
