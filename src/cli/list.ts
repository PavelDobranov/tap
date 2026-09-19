import { resolveProject } from "../project.ts";
import { openProjectStore } from "../store/database.ts";
import { listSessions } from "../store/sessions.ts";
import { formatTable } from "./table.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, type Io } from "./io.ts";

const HEADERS = ["ID", "AGENT", "STATUS", "STARTED"];

/** `tap list` — this project's recorded sessions. */
export function list(argv: readonly string[], io: Io): number {
  // --stats is part of the published usage but belongs to the milestone that
  // records captures; say so rather than reject a documented flag.
  if (argv.includes("--stats")) {
    io.stderr.write("tap: list --stats is not implemented yet.\n");
    return EXIT_FAILURE;
  }

  const unknown = argv.find((argument) => argument.startsWith("-"));
  if (unknown !== undefined) {
    io.stderr.write(`tap: unknown option: ${unknown}\n`);
    return EXIT_USAGE;
  }

  const db = openProjectStore(resolveProject(process.cwd()));
  try {
    const rows = listSessions(db).map((session) => [
      session.id,
      session.agent,
      session.status,
      formatTimestamp(session.startedAt),
    ]);
    io.stdout.write(formatTable(HEADERS, rows));
    return EXIT_OK;
  } finally {
    db.close();
  }
}

/** Local time to the minute: enough to pick a session out, short enough to scan. */
function formatTimestamp(epochMillis: number): string {
  const at = new Date(epochMillis);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}
