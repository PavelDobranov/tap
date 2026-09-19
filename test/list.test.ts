import assert from "node:assert/strict";
import { test } from "node:test";
import { inStore, makeWorkspace } from "./helpers/workspace.ts";
import { runTap } from "./helpers/run-tap.ts";

test("inside a git repository prints an empty session table", async (t) => {
  const workspace = makeWorkspace(t);
  const project = workspace.gitInit("repo");

  const result = await runTap(["list"], { cwd: project, env: workspace.env });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^ID\s+AGENT\s+STATUS\s+STARTED\s*$/m);
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("a recorded session appears in the table", async (t) => {
  const workspace = makeWorkspace(t);
  const project = workspace.gitInit("repo");
  // Until `tap launch` exists there is nothing that records a session, so the
  // row is seeded directly; everything asserted about it goes through the CLI.
  const startedAt = new Date(2026, 0, 2, 3, 4).getTime();
  inStore(
    workspace,
    project,
    `db.prepare(\`INSERT INTO sessions
       (id, agent, status, cwd, pid, port, exit_code, signal, started_at, ended_at)
       VALUES ('a1b2c3d4', 'claude', 'completed', ?, 4242, 51234, 0, NULL, ?, ?)\`)
      .run(${JSON.stringify(project)}, ${startedAt}, ${startedAt + 1000});`,
  );

  const result = await runTap(["list"], { cwd: project, env: workspace.env });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^a1b2c3d4\s+claude\s+completed\s+2026-01-02 03:04$/m);
});

test("--stats is advertised but reports that it is not implemented yet", async (t) => {
  const workspace = makeWorkspace(t);
  const project = workspace.gitInit("repo");

  const result = await runTap(["list", "--stats"], { cwd: project, env: workspace.env });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not implemented yet/i);
});
