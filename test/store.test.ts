import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { inStore, makeWorkspace, projectStores, tapList } from "./helpers/workspace.ts";

test("the store is created under the user's home directory, mode 0700", async (t) => {
  const workspace = makeWorkspace(t);
  const repository = workspace.gitInit("repo");

  await tapList(workspace, repository);

  const store = path.join(workspace.home, ".tap");
  const [project] = projectStores(workspace);
  assert.ok(project, "no project store was created");

  for (const dir of [store, path.join(store, "projects"), path.join(store, "projects", project)]) {
    assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} is not mode 0700`);
  }
});

test("the database is opened with the durability and concurrency pragmas", (t) => {
  const workspace = makeWorkspace(t);
  const repository = workspace.gitInit("repo");

  // Pragmas belong to the connection that set them, so this is the one thing
  // about the store that no second connection — and no `tap` invocation — can
  // report. It is read on the open connection instead.
  const pragmas = JSON.parse(
    inStore(
      workspace,
      repository,
      `const read = (name) => Object.values(db.prepare("PRAGMA " + name).get())[0];
       console.log(JSON.stringify({
         journal_mode: read("journal_mode"),
         synchronous: read("synchronous"),
         busy_timeout: read("busy_timeout"),
         foreign_keys: read("foreign_keys"),
       }));`,
    ),
  ) as Record<string, unknown>;

  assert.deepEqual(pragmas, {
    journal_mode: "wal",
    synchronous: 1, // NORMAL
    busy_timeout: 5000,
    foreign_keys: 1,
  });
});

test("the project's own root path is recorded inside its database", (t) => {
  const workspace = makeWorkspace(t);
  const repository = workspace.gitInit("repo");

  const recorded = inStore(
    workspace,
    repository,
    `console.log(db.prepare("SELECT root FROM project WHERE id = 1").get().root);`,
  );

  assert.equal(recorded.trim(), repository);
});
