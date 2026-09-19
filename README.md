# tap

Context forensics for Claude Code. `tap launch claude` records every request
Claude Code sends to the provider, so you can read afterwards what the model was
actually given.

`tap list` works: it resolves the project you are standing in, creates its
store on first use, and prints its session table — empty until `tap launch`
exists to record one. The other commands still report that they are not
implemented.

## Project identity and storage

A project is its git repository root, falling back to the working directory
outside a repository, so running from a subdirectory reads the same project.
Captures live entirely outside the repository, under `~/.tap/projects/<hash>`,
mode 0700 — nothing is ever written into the working tree.

## Requirements

Node >= 24. Tap uses the Node runtime's built-in SQLite module and has no native
dependencies, so installing it never compiles anything.

## Development

```sh
npm install
npm run build      # TypeScript -> dist/, with an executable dist/cli.js
npm test           # builds, then runs the suite against the built binary
npm run typecheck  # sources, tests and scripts
npm run check:no-native
```

Tests assert external behaviour only, through the one seam the project has: the
`tap` process boundary.
