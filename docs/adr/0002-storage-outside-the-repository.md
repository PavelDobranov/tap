# Storage outside the repository, keyed by git root

A Tap project is identified by its git repository root, and its store lives
under the user's home directory in a directory named by a truncated hash of the
canonicalised root, mode `0700`. An in-repo `.tap/` directory was rejected:
captured payloads contain the repository's own source and whatever secrets
reached the agent's context, and an in-tree binary database is one `git add -A`
away from being published.

## Consequences

The project is discoverable rather than declared, so there is **no `tap init`**
and **no config file** — both existed in the original design only to support an
in-repo project marker, and a config file with nothing to configure is
ceremony. Launching from a subdirectory records into the same project. The
original root path is stored inside the project's own database so a future
cross-project view could resolve hashed directory names back to readable paths.

Moving the store out of the tree removes the accidental-commit risk but not the
backup, sync or stolen-laptop risk; `tap rm` is part of the tool's contract
rather than a convenience.

## Superseded

Superseded by ADR-0005: nothing is stored at all, so there is no store to place
and no project to key it by.
