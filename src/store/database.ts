import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { databasePath, projectDir } from "./paths.ts";

/**
 * WAL so a reader (`tap list`) never blocks the writer capturing a live
 * session; NORMAL because losing the last writes to a power cut is acceptable
 * for a capture tool and FULL costs an fsync per commit on the response path;
 * a busy timeout so concurrent sessions in the same project wait rather than
 * fail; foreign keys because the capture schema relies on them.
 */
const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA foreign_keys = ON",
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  root TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'running', 'completed', 'failed', 'abandoned')
  ),
  cwd TEXT NOT NULL,
  pid INTEGER,
  port INTEGER,
  exit_code INTEGER,
  signal TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
`;

/**
 * Opens the project's database, creating the store on first use. There is no
 * `tap init`: every command that needs storage bootstraps it.
 */
export function openProjectStore(root: string): DatabaseSync {
  // 0700 because the captures are readable source code and secrets, and this
  // machine may have other users.
  mkdirSync(projectDir(root), { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(databasePath(root));
  for (const pragma of PRAGMAS) db.exec(pragma);
  db.exec(SCHEMA);
  recordProjectRoot(db, root);
  return db;
}

/**
 * The store directory is named by a hash, so the readable path is kept inside
 * the database: it is the only thing that can map a hashed directory back to
 * the project a human would recognise.
 */
function recordProjectRoot(db: DatabaseSync, root: string): void {
  db.prepare(
    `INSERT INTO project (id, root) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET root = excluded.root`,
  ).run(root);
}
