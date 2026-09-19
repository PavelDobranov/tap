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
 *
 * The readers that answer "what did this object carry" — usage, model, tool
 * uses — are the exception, and answer nothing where an object carried
 * nothing. Most response objects carry none of the three, so an absence there
 * is the ordinary case rather than a failure to read one.
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

/** A tool-use block as a response presented it. */
export interface ToolUse {
  /** The provider's id for the block, and what makes it one block twice seen. */
  readonly id: string;
  readonly name: string;
}

/**
 * The tool-use blocks one response object carries, if it carries any.
 *
 * Two shapes have them: a `content_block_start` event opening one, and a
 * whole message whose `content` holds them. A streamed block is reported from
 * its opening event rather than from its accumulated input, so a subagent
 * invocation is in the record while its input is still being written — and so
 * that reading it needs no reassembly of `input_json_delta` fragments.
 *
 * A block with no id or no name is not reported: a tool use Tap cannot name
 * is not a fact worth writing down as one.
 */
export function readToolUses(value: unknown): readonly ToolUse[] {
  const object = asObject(value);
  if (object === undefined) return [];

  const blocks = [
    object["content_block"],
    ...asArray(object["content"]),
    ...asArray(asObject(object["message"])?.["content"]),
  ];
  return blocks.map(asToolUse).filter((block): block is ToolUse => block !== null);
}

function asToolUse(value: unknown): ToolUse | null {
  const block = asObject(value);
  if (block?.["type"] !== "tool_use") return null;
  const { id, name } = block;
  return typeof id === "string" && typeof name === "string" ? { id, name } : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** What one pass over a run of server-sent events found. */
export interface SseFrames {
  /** Whole events, verbatim and in order, each ending in its blank line. */
  events: string[];
  /** The content of every complete `data:` line, closed event or not. */
  dataLines: string[];
  /** Whatever is not a whole event yet, to be scanned again with what follows. */
  rest: string;
}

/**
 * Frames a run of server-sent events: the events that are complete in
 * `buffered`, the `data:` lines they carry, and the trailing bytes that are
 * not yet a whole event.
 *
 * Events and data lines are framed differently on purpose. An event is
 * complete only at its blank line, because the record holds it as the upstream
 * wrote it; a `data:` line is complete the moment its own newline arrives, so
 * a response in flight gives up its usage without waiting for the event it
 * belongs to to be closed. A line inside an event that is still open is
 * therefore reported again on the next pass — reading the same usage twice
 * costs nothing, and delaying it would cost the live view its point.
 *
 * Framing only — nothing here parses. A line Tap cannot read must not be able
 * to stop the buffer advancing past it, or a single bad one would make every
 * later chunk rescan a buffer that only ever grows.
 */
export function readSse(buffered: string): SseFrames {
  const lines = buffered.split("\n");
  const trailing = lines.pop() ?? "";
  const events: string[] = [];
  const dataLines: string[] = [];

  let opened = 0;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("data:")) {
      const content = line.slice("data:".length).trim();
      // A stream may signal its end with a sentinel rather than an object; that
      // is not something Tap failed to read.
      if (content !== "" && content !== "[DONE]") dataLines.push(content);
    }
    if (line.trim() !== "") continue;
    // A blank line closes whatever was open. A run of them closes nothing:
    // an event with no content is separator, not evidence.
    const event = lines.slice(opened, index + 1);
    opened = index + 1;
    if (event.some((text) => text.trim() !== "")) events.push(`${event.join("\n")}\n`);
  }

  return { events, dataLines, rest: [...lines.slice(opened), trailing].join("\n") };
}

function asObject(value: unknown): { [key: string]: unknown } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { [key: string]: unknown })
    : undefined;
}
