# No TUI and no IPC in v0

A two-pane live-updating TUI, and the IPC layer that would feed it, were the
final two milestones of the original plan. Both are **deleted, not deferred**.
Live updating is the least valuable property of a forensics tool and the most
expensive to build; reading a 100k-token conversation is something an editor
and a pager already do better than any hand-built TUI. With no live consumer,
an IPC layer is speculative infrastructure.

## Consequences

There is no daemon and no IPC: each `tap launch` owns one agent process, one
proxy, one capture pipeline and one database connection, and `tap list` and
`tap show` read the database directly. `tap attach` does not exist. Whether a
TUI is wanted at all is a question to answer after living with `tap show`.

## Superseded

Superseded by ADR-0005. The conclusion held against a hand-built TUI and not
against a browser UI served by the proxy that already exists; the question
"after living with `tap show`" was answered before `tap show` was built, by
reframing Tap as live rather than post-hoc.
