#!/usr/bin/env node
import { run } from "./cli/run.ts";

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
});

process.exitCode = code;
