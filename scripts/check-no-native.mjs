#!/usr/bin/env node
// Fails if anything in the production dependency tree would compile or ship
// native code. Tap's whole install story — and the choice of node:sqlite over
// a native binding — rests on this staying true, so it is checked rather than
// assumed.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const NATIVE_FILES = new Set(["binding.gyp", "binding.gypi"]);
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"];

/** Every package directory in the production dependency tree, including the root. */
function productionPackageDirs() {
  const raw = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json", "--long"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const dirs = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.path === "string") dirs.add(node.path);
    for (const child of Object.values(node.dependencies ?? {})) visit(child);
  };
  visit(JSON.parse(raw));
  return [...dirs];
}

/** Native artefacts anywhere inside a package, ignoring nested dependencies. */
function nativeArtefacts(dir) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (NATIVE_FILES.has(entry.name) || entry.name.endsWith(".node")) {
        found.push(path.relative(root, full));
      }
    }
  };
  walk(dir);
  return found;
}

const rootManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const declared = new Set(Object.keys(rootManifest.dependencies ?? {}));

const problems = [];
const seen = new Set();
for (const dir of productionPackageDirs()) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const name = manifest.name ?? path.relative(root, dir);
  seen.add(name);
  for (const hook of INSTALL_HOOKS) {
    if (manifest.scripts?.[hook]) {
      problems.push(`${name}: has a ${hook} script (${manifest.scripts[hook]})`);
    }
  }
  if (manifest.gypfile) problems.push(`${name}: declares gypfile`);
  for (const artefact of nativeArtefacts(dir)) {
    problems.push(`${name}: native artefact ${artefact}`);
  }
}

// Without this, an uninstalled node_modules would make the scan pass vacuously.
for (const dependency of declared) {
  if (!seen.has(dependency)) {
    problems.push(`${dependency}: declared but not installed — run 'npm install' first`);
  }
}

if (problems.length > 0) {
  console.error("Native code found in the production dependency tree:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("No native code in the production dependency tree.");
