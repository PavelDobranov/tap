/**
 * Reading the request list as prompts and the work each one set off, with
 * nothing on the wire that says where one ends.
 *
 * Claude Code sends no turn boundary, and no request says whether a person
 * was waiting for it. What it does send is the whole conversation, so the
 * shape of the last message is the only evidence there is: a request whose
 * final message is from the user and carries no tool result is one the agent
 * made because it had just been asked something, and every other request is
 * work it was already doing.
 *
 * That rule is an *inference*, and a knowingly imperfect one. A compaction
 * rewrites history into a user message and looks turn-initial; a prompt
 * queued during a tool loop arrives beside a tool result and does not. Both
 * artefacts are accepted rather than guessed around, because the guess that
 * would fix either one would have to claim something the wire cannot show.
 * The cost of being wrong is bounded by what a turn is allowed to do: group
 * the request list for reading. A misplaced boundary puts a divider in the
 * wrong place, and can never hide, drop or reorder a request.
 */

/**
 * The turns of a Tap session, derived one thread at a time.
 *
 * Threads are the unit because turns are: two conversations in flight at
 * once interleave on the wire, and a turn counted across them would number a
 * subagent's first request as the main conversation's fourth.
 */
export interface Turns {
  /**
   * The turn a request belongs to, from the thread it continues and its final
   * message as it arrived.
   *
   * Null where there is nothing to derive one from: a request with no thread
   * has no conversation to be a turn of, and one with no final message — a
   * request Tap does not read as conversation, or one carrying no messages —
   * is left ungrouped rather than given an invented turn.
   *
   * Only `messages` requests belong here. A `count_tokens` request shares a
   * thread's prefix without being work in its turn, so the caller hands it
   * over as ungrouped and the count it would have advanced stays put.
   *
   * Total and synchronous, because it is called from the capture path.
   */
  attribute(thread: number | null, finalMessage: string | null): number | null;
}

export function createTurns(): Turns {
  /** The turn each thread is in, by thread id. Numbered from 1 within it. */
  const current = new Map<number, number>();

  return {
    attribute(thread, finalMessage) {
      if (thread === null || finalMessage === null) return null;
      const open = current.get(thread);
      // A thread first seen mid-loop has no open turn to continue. Its first
      // request is turn 1 of it either way: the turn it really continues was
      // never captured, and numbering from 2 to leave a space for it would
      // assert a request Tap never saw.
      const turn = beginsTurn(finalMessage) ? (open ?? 0) + 1 : (open ?? 1);
      current.set(thread, turn);
      return turn;
    },
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
