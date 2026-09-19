import { createHash } from "node:crypto";

/**
 * Canonical JSON: one spelling for one value, so that two units carrying the
 * same content hash alike however the agent happened to serialise them.
 *
 * **The key ordering is fixed and will not change.** Object keys are sorted
 * ascending by UTF-16 code unit — `Array.prototype.sort` with no comparator,
 * which puts `"A"` before `"a"` and both before `"é"`. Arrays keep the order
 * they were written in, because in JSON that order is content. Nothing is
 * indented and no separator carries a space.
 *
 * It is fixed now because it is expensive to change later: every hash in a
 * session is derived from it, so a different ordering is a different address
 * for the same content. Within one run that merely wastes deduplication, but
 * the diff view compares ordered hash lists across requests and needs the
 * ordering to be stable for as long as those lists are comparable.
 *
 * Canonicalisation is used for addressing only, never for reconstruction: the
 * bytes handed back to a reader are the bytes that arrived, not these. So a
 * value this spells lossily — a number JSON cannot hold, say — can cost a
 * blob's worth of deduplication and can never cost fidelity.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return spell(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { [key: string]: unknown };
  const members = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${members.join(",")}}`;
}

/**
 * One scalar, as JSON spells it. `JSON.stringify` answers `undefined` for the
 * values JSON has no word for; canonical JSON has to answer something, and
 * `null` is what the same value would become inside an array anyway.
 */
function spell(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/**
 * The address of a unit: SHA-256 of its canonical JSON, in hex.
 *
 * Content-addressed and nothing else — the address says what the unit is, not
 * where it came from or when, which is exactly what lets the same message
 * resent in fifty requests be held once.
 */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
