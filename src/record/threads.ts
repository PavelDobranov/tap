import { createHash } from "node:crypto";

/**
 * Telling one conversation lineage from another with nothing on the wire that
 * says so.
 *
 * Claude Code sends no conversation identifier. What it does send is the whole
 * conversation, every time: a request that continues a conversation repeats
 * every message of it and adds to the end. So requests of one lineage share a
 * *prefix* of messages, and a request whose prefix has never been seen is a
 * lineage that has not been seen either.
 *
 * That is all the wire supports, and this module claims no more than it. A
 * thread is a fact about prefixes; *why* a new prefix appeared — a subagent, a
 * `/clear`, a `--resume`, a compaction that rewrote history — is not
 * observable here, so threads are numbered and never named. Confident
 * misattribution is worse than none.
 */

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

export interface Threads {
  /**
   * The thread a request belongs to, given the addresses of its messages in
   * wire order. Null when there is no prefix to derive one from: a request
   * with no messages says nothing about lineage, and putting it in the main
   * thread because it had to go somewhere would be an assertion the wire does
   * not support.
   *
   * Total and synchronous, because it is called from the capture path.
   */
  attribute(seq: number, messages: readonly string[]): number | null;
  list(): readonly Thread[];
}

/**
 * The prefix of no messages. Never registered against a thread — every
 * conversation has it, so matching on it would put every request in whichever
 * thread happened to arrive first.
 */
const ROOT = "";

export function createThreads(): Threads {
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

  const open = (firstSeq: number): number => {
    const id = threads.length + 1;
    threads.push({ id, main: id === 1, firstSeq });
    return id;
  };

  return {
    attribute(seq, messages) {
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

      const id = found ?? open(seq);
      for (const each of prefixes) if (!seen.has(each)) seen.set(each, id);
      return id;
    },

    list: () => [...threads],
  };
}

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
