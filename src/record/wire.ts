import type { Usage } from "./record.ts";

/**
 * Reading facts off the wire: the model a request asked for, and the token and
 * cache usage a response reported. Tap needs both and keeps neither payload —
 * these functions are given bytes and hand back the few facts the record
 * holds, so nothing in this module retains what it was shown.
 *
 * Everything here throws on malformed input rather than returning a quiet
 * null. A stream Tap could not read is a capture failure, and fail-open only
 * works if failure is loud enough to become a diagnostic.
 */

/** The model a request asked for, or null if it named none. */
export function readModel(body: string): string | null {
  const parsed: unknown = JSON.parse(body);
  const model = asObject(parsed)?.["model"];
  return typeof model === "string" ? model : null;
}

/** The wire's usage names, in Tap's vocabulary. */
const FIELDS: readonly (readonly [string, keyof Usage])[] = [
  ["input_tokens", "inputTokens"],
  ["output_tokens", "outputTokens"],
  ["cache_creation_input_tokens", "cacheCreationInputTokens"],
  ["cache_read_input_tokens", "cacheReadInputTokens"],
];

/**
 * Usage from one response object, or null if it reported none.
 *
 * Three shapes carry it: a completed message and a `message_delta` event have
 * a `usage` of their own, a `message_start` event has one nested in the
 * message it opens, and a `count_tokens` answer is bare counts at the top
 * level. Looking in all three places is cheaper than knowing which is which.
 */
export function readUsage(value: unknown): Usage | null {
  const object = asObject(value);
  if (object === undefined) return null;

  const sources = [
    object,
    asObject(object["usage"]),
    asObject(asObject(object["message"])?.["usage"]),
  ];
  const usage: Usage = {};
  let found = false;
  for (const source of sources) {
    for (const [wire, field] of FIELDS) {
      const count = source?.[wire];
      if (typeof count !== "number") continue;
      usage[field] = count;
      found = true;
    }
  }
  return found ? usage : null;
}

/** The model a response named, if it named one — `message_start` does. */
export function readResponseModel(value: unknown): string | null {
  const object = asObject(value);
  const model = object?.["model"] ?? asObject(object?.["message"])?.["model"];
  return typeof model === "string" ? model : null;
}

/**
 * Frames a run of server-sent events: the `data:` payloads that are complete
 * in `buffered`, and whatever trailing bytes are not a whole line yet.
 *
 * Splitting on the line rather than on the blank-line event boundary is
 * deliberate: a `data:` line is complete the moment its newline arrives, so a
 * response in flight gives up its usage without waiting for the event it
 * belongs to to be closed.
 *
 * Framing only — nothing here parses. A payload Tap cannot read must not be
 * able to stop the buffer advancing past it, or a single bad line would make
 * every later chunk rescan a buffer that only ever grows.
 */
export function readSseData(buffered: string): { payloads: string[]; rest: string } {
  const lines = buffered.split("\n");
  const rest = lines.pop() ?? "";
  const payloads: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    // A stream may signal its end with a sentinel rather than an object; that
    // is not something Tap failed to read.
    if (payload === "" || payload === "[DONE]") continue;
    payloads.push(payload);
  }
  return { payloads, rest };
}

function asObject(value: unknown): { [key: string]: unknown } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { [key: string]: unknown })
    : undefined;
}
