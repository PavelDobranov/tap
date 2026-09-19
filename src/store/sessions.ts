import type { DatabaseSync } from "node:sqlite";

/**
 * How a session ended, or that it has not. Signal termination counts as
 * `completed`: ending an interactive agent with Ctrl+C is the normal way a
 * session ends, and the exit code and signal are kept separately so the
 * distinction survives.
 */
export const SESSION_STATUSES = [
  "starting",
  "running",
  "completed",
  "failed",
  "abandoned",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

export interface Session {
  readonly id: string;
  readonly agent: string;
  readonly status: SessionStatus;
  readonly startedAt: number;
}

/** A project's sessions, most recent first. */
export function listSessions(db: DatabaseSync): Session[] {
  const rows = db
    .prepare(`SELECT id, agent, status, started_at FROM sessions ORDER BY started_at DESC, id DESC`)
    .all() as { id: string; agent: string; status: string; started_at: number }[];

  return rows.map((row) => ({
    id: row.id,
    agent: row.agent,
    status: toStatus(row.status),
    startedAt: row.started_at,
  }));
}

/** The database constrains this column, so an unknown value means a corrupt store. */
function toStatus(value: string): SessionStatus {
  const status = SESSION_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) throw new Error(`unknown session status: ${value}`);
  return status;
}
