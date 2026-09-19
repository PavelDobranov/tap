/**
 * Finding the addressable parts of a request body *in the text that arrived*,
 * rather than in a value parsed out of it.
 *
 * Working in spans is what makes exact reconstruction free. A skeleton built
 * from offsets is the original bytes with holes in it, so filling the holes
 * back in cannot introduce a re-serialisation — no reordered key, no lost
 * whitespace, no `1.0` that comes back as `1`. Nothing here parses a value it
 * does not have to: it reads structure, and hands back where things are.
 */

/** A half-open range of the payload text. */
export interface Span {
  readonly from: number;
  readonly to: number;
}

/**
 * One addressable part of a payload, and whether it is conversation.
 *
 * A unit says which member it came out of rather than leaving a caller to
 * work it out from where it sits: a thread is derived from the messages
 * alone, and `system` and `tools` are configuration resent with every request
 * rather than conversation lineage.
 */
export interface Unit extends Span {
  readonly message: boolean;
}

/** Where the addressable parts of one payload are. */
export interface Located {
  /**
   * The units, ascending and disjoint: the value of `system`, the value of
   * `tools`, and each element of `messages`, whichever of them are there.
   */
  readonly units: readonly Unit[];
  /**
   * Every `cache_control` member, ascending and disjoint, as the span to cut
   * out — leading comma, trailing comma or neither, so that what is left is
   * still the JSON it was.
   */
  readonly annotations: readonly Span[];
}

/**
 * The member key that moves. Claude Code re-places its cache breakpoints from
 * one request to the next, so an otherwise unchanged message arrives spelled
 * differently and would address differently. It is cut before hashing and put
 * back on the way out, which is the difference between deduplicating a long
 * conversation and not deduplicating it at all.
 */
const ANNOTATION = "cache_control";

/** The top-level members whose whole value is one unit. */
const WHOLE_UNITS: readonly string[] = ["system", "tools"];

/** The top-level member each of whose elements is a unit. */
const UNIT_ELEMENTS = "messages";

/**
 * Where the units and annotations of a payload are, or null if the payload is
 * not a JSON object — which is not a failure. A body Tap cannot take apart is
 * a body Tap keeps whole, and the caller does exactly that.
 */
export function locate(payload: string): Located | null {
  const scan: Scan = { text: payload, at: 0, annotations: [] };
  let shape: Shape;
  try {
    shape = scanValue(scan, true);
    skipSpace(scan);
  } catch {
    return null;
  }
  if (scan.at !== payload.length || shape.kind !== "object") return null;

  const units: Unit[] = [];
  for (const member of shape.members) {
    if (WHOLE_UNITS.includes(member.key)) units.push({ ...member.value, message: false });
    else if (member.key === UNIT_ELEMENTS && member.shape.kind === "array") {
      units.push(...member.shape.elements.map((span) => ({ ...span, message: true })));
    }
  }

  return { units: ascending(units), annotations: ascending(scan.annotations) };
}

/**
 * Spans in order, with any span swallowed by the one before it dropped. Only
 * a `cache_control` nested inside another `cache_control` produces one, and
 * cutting it twice would cut bytes that were already gone.
 */
function ascending<T extends Span>(spans: T[]): T[] {
  const sorted = [...spans].sort((a, b) => a.from - b.from);
  return sorted.filter((span, index) => index === 0 || span.from >= sorted[index - 1]!.to);
}

/** One pass over the text, left to right, collecting annotations as it goes. */
interface Scan {
  readonly text: string;
  at: number;
  readonly annotations: Span[];
}

/**
 * What a scanned value turned out to be. Structure is reported only where the
 * caller asked for it: everything below the units is scanned for its extent
 * and for annotations, and its shape is thrown away rather than built into a
 * tree the size of the payload.
 */
type Shape =
  | { readonly kind: "object"; readonly members: readonly Member[] }
  | { readonly kind: "array"; readonly elements: readonly Span[] }
  | { readonly kind: "scalar" };

const SCALAR: Shape = { kind: "scalar" };

interface Member {
  readonly key: string;
  /** Where the key's opening quote is: the start of the member. */
  readonly from: number;
  readonly value: Span;
  readonly shape: Shape;
}

function scanValue(scan: Scan, keep: boolean): Shape {
  skipSpace(scan);
  switch (scan.text[scan.at]) {
    case "{":
      return scanObject(scan, keep);
    case "[":
      return scanArray(scan, keep);
    case '"':
      scanString(scan);
      return SCALAR;
    default:
      scanScalar(scan);
      return SCALAR;
  }
}

function scanObject(scan: Scan, keep: boolean): Shape {
  scan.at += 1;
  const members: Member[] = [];

  skipSpace(scan);
  if (scan.text[scan.at] === "}") scan.at += 1;
  else
    for (;;) {
      skipSpace(scan);
      const from = scan.at;
      expect(scan, '"');
      scanString(scan);
      const key = JSON.parse(scan.text.slice(from, scan.at)) as string;
      skipSpace(scan);
      expect(scan, ":");
      scan.at += 1;
      skipSpace(scan);
      const valueFrom = scan.at;
      // Only `messages` is taken apart element by element; the units
      // themselves are held whole, so nothing below them needs a shape.
      const shape = scanValue(scan, keep && key === UNIT_ELEMENTS);
      members.push({ key, from, value: { from: valueFrom, to: scan.at }, shape });
      skipSpace(scan);
      if (scan.text[scan.at] === ",") {
        scan.at += 1;
        continue;
      }
      expect(scan, "}");
      scan.at += 1;
      break;
    }

  // Cut with a comma on whichever side has one: the member before it if there
  // is one, otherwise the member after it, otherwise neither and the object is
  // left empty.
  for (const [index, member] of members.entries()) {
    if (member.key !== ANNOTATION) continue;
    const previous = members[index - 1];
    const next = members[index + 1];
    if (previous !== undefined) {
      scan.annotations.push({ from: previous.value.to, to: member.value.to });
    }
    else if (next !== undefined) scan.annotations.push({ from: member.from, to: next.from });
    else scan.annotations.push({ from: member.from, to: member.value.to });
  }

  return keep ? { kind: "object", members } : SCALAR;
}

function scanArray(scan: Scan, keep: boolean): Shape {
  scan.at += 1;
  const elements: Span[] = [];

  skipSpace(scan);
  if (scan.text[scan.at] === "]") scan.at += 1;
  else
    for (;;) {
      skipSpace(scan);
      const from = scan.at;
      scanValue(scan, false);
      elements.push({ from, to: scan.at });
      skipSpace(scan);
      if (scan.text[scan.at] === ",") {
        scan.at += 1;
        continue;
      }
      expect(scan, "]");
      scan.at += 1;
      break;
    }

  return keep ? { kind: "array", elements } : SCALAR;
}

/** A string, escapes and all, leaving the scan just past its closing quote. */
function scanString(scan: Scan): void {
  scan.at += 1;
  for (;;) {
    const character = scan.text[scan.at];
    if (character === undefined) throw new Error("a string that never closes");
    scan.at += 1;
    if (character === "\\") scan.at += 1;
    else if (character === '"') return;
  }
}

/**
 * A number, `true`, `false` or `null`: everything up to whatever ends it.
 * Not validated — the scan's job is extent, and a payload this misreads is
 * caught by the parse the caller does of what it cut out.
 */
function scanScalar(scan: Scan): void {
  const from = scan.at;
  while (scan.at < scan.text.length && !/[\s,\]}]/.test(scan.text[scan.at]!)) scan.at += 1;
  if (scan.at === from) throw new Error(`nothing that could be a value at ${from}`);
}

function skipSpace(scan: Scan): void {
  while (scan.at < scan.text.length && /\s/.test(scan.text[scan.at]!)) scan.at += 1;
}

function expect(scan: Scan, character: string): void {
  if (scan.text[scan.at] !== character) {
    throw new Error(`expected ${character} at ${scan.at}`);
  }
}
