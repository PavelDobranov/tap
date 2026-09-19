import assert from "node:assert/strict";
import { readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeWorkspace, projectStores, tapList } from "./helpers/workspace.ts";

test("outside a git repository each working directory is its own project", async (t) => {
  const workspace = makeWorkspace(t);
  const one = workspace.mkdir("loose-one");
  const two = workspace.mkdir("loose-two");

  await tapList(workspace, one);
  await tapList(workspace, one);
  await tapList(workspace, two);

  assert.equal(projectStores(workspace).length, 2);
});

test("a subdirectory of a repository resolves to the same project as its root", async (t) => {
  const workspace = makeWorkspace(t);
  const repository = workspace.gitInit("repo");
  const nested = workspace.mkdir("repo/src/deep");

  await tapList(workspace, repository);
  await tapList(workspace, nested);

  assert.equal(projectStores(workspace).length, 1);
});

test("a symlinked path resolves to the same project as the real one", async (t) => {
  const workspace = makeWorkspace(t);
  const repository = workspace.gitInit("repo");
  const link = path.join(workspace.root, "link-to-repo");
  symlinkSync(repository, link);

  await tapList(workspace, repository);
  await tapList(workspace, link);

  assert.equal(projectStores(workspace).length, 1);
});

test("nothing is written into the working tree", async (t) => {
  const workspace = makeWorkspace(t);
  const repository = workspace.gitInit("repo");
  const before = readdirSync(repository).sort();

  await tapList(workspace, repository);

  assert.deepEqual(readdirSync(repository).sort(), before);
  assert.equal(projectStores(workspace).length, 1);
});
