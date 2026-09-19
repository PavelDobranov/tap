# Tap

Tap is a live network inspector for Claude Code: it sits between the agent and
the provider and shows you, as it happens, exactly what is being sent to the
model and what comes back. Nothing is written to disk and nothing outlives the
session. This glossary is the vocabulary that code, tickets and commit messages
should use.

## Language

### The observed program

**Agent**:
The program Tap launches and observes. In v0 it is always Claude Code, and
agent-specific knowledge lives in one module rather than behind an interface.
_Avoid_: adapter, client, target, `AgentAdapter`

**Tap session**:
One launched agent process, from `tap launch` until Tap itself exits. Recording
is bound to the agent's life; serving the record outlives it, so a Tap session
has a live phase and a frozen phase.
_Avoid_: run, recording, capture session, session (unqualified)

**Claude Code session**:
The agent's *own* conversation identity, which can span several processes
(`--resume`) or reset within one (`/clear`). Tap cannot observe it and does not
try to; it is never what "session" means in Tap's code or CLI.
_Avoid_: session (unqualified)

**Frozen**:
The state of a Tap session after the agent has exited: the record stops growing
but stays readable until Tap is interrupted.
_Avoid_: finished, closed, ended, stopped

### Interception

**Proxy**:
The HTTP server the agent's requests are pointed at, bound on an ephemeral
port on the loopback address and in the path for the live phase of a Tap
session only. It is transparent: what reaches the upstream is what the agent
sent, and what reaches the agent is what the upstream sent, chunk for chunk.
_Avoid_: interceptor, gateway, MITM, forwarder

**Upstream**:
Where Tap forwards requests: the base URL inherited from the environment if one
is set, otherwise the default Anthropic API.
_Avoid_: provider, backend, origin, target

**Unsupported configuration**:
An environment that points the agent at a cloud provider rather than the
Anthropic API — any `CLAUDE_CODE_USE_*` variable. The upstream has no base URL
to override there, so Tap refuses the launch instead of serving an empty
record.
_Avoid_: unsupported provider, cloud mode, non-Anthropic backend

**Request**:
Anything that reaches the proxy, whether or not Tap understands it. Every
request is typed `messages`, `count_tokens` or `other`, and all three are
recorded.
_Avoid_: call, turn, exchange

**Fail-open**:
The invariant that a failure in capture — exhausted memory, parse error, a
viewer that stalled — is surfaced as a diagnostic and otherwise ignored, never
allowed to abort, delay or alter the agent's request.
_Avoid_: best-effort, graceful degradation, non-blocking

**Credential non-inspection**:
The invariant that the `Authorization` header is copied from the inbound
request to the upstream request without being read, parsed, logged or stored.
Fail-open's security sibling: both are tested invariants, not aspirations.
_Avoid_: redaction, scrubbing, sanitising, stripping

### The record

**Record**:
Everything Tap has captured in the current Tap session, held in memory. It is
the whole of Tap's state: there is no store, no project, and nothing on disk.
_Avoid_: store, database, capture, history, log

**Unit**:
The granularity at which payload content is addressed: the `system` block, the
`tools` array, or one element of `messages[]`.
_Avoid_: block, segment, part, chunk

**Blob**:
A stored unit, content-addressed by SHA-256 of its canonical JSON with
position-dependent annotations such as `cache_control` stripped before hashing.
Blobs are what eviction acts on.
_Avoid_: object, fragment, entry

**Skeleton**:
A captured request with its units replaced by blob references, retaining the
annotations that were stripped before hashing. Reconstruction from a skeleton
and its blobs is exact.
_Avoid_: envelope, stub, manifest, normalised payload

**Raw response**:
The response events exactly as they streamed from upstream. Kept while the
response is in flight, and discarded once it has been reassembled — except when
reassembly fails or the stream was cut, where the raw events are the record.
_Avoid_: stream, chunks, unparsed response

**Reassembled response**:
The final message object rebuilt from the raw response for reading.
_Avoid_: parsed response, final response, rendered response

**Eviction**:
Dropping the oldest blobs when the record reaches its memory cap. Always shown
in the UI, never silent, because a missing record read as an absent event is
the one failure that produces a confident wrong conclusion.
_Avoid_: pruning, trimming, rotation, GC

**Diagnostic**:
A recorded failure of capture itself, surfaced in the UI alongside the record.
The visible half of fail-open.
_Avoid_: error log, warning, session log

### Interpreting the record

**Thread**:
A conversation lineage within a Tap session, derived by hashing each request's
message prefix: requests sharing a prefix are one thread. Threads are labelled
neutrally and numbered, because the wire can show that a request belongs to a
different thread but cannot show *why* — a subagent, a `/clear`, a `--resume`
and a compaction are indistinguishable, so Tap names none of them.
_Avoid_: conversation, branch, subagent thread, sidechain

**Main thread**:
The first thread seen in a Tap session, and the default thing to read.
_Avoid_: parent thread, root thread, primary conversation

**Turn**:
A user prompt and every provider request the agent makes before it next needs
input. Derived, within a thread, from the shape of `messages[]`: a request
begins a new turn when its final message is from the user and contains no
`tool_result` block; every other request continues the current turn. Like
thread attribution this is an *inference* — a compaction can look turn-initial,
and a prompt queued mid-tool-loop will not — so turns group the request list
for reading and never hide a request.
_Avoid_: exchange, round, interaction, conversation turn

**Subagent invocation**:
A tool-use block observed in a captured response. It is a *fact* about a
delegation, as opposed to thread attribution, which is an inference — the
distinction is why "subagent" is not a thread label.
_Avoid_: subagent, subagent session, delegation

### The viewer

**UI**:
The local web page Tap serves, and the only way to read the record. Served on
its own port, separate from the proxy, `Host`-validated and reachable only with
the token in its URL, because it exposes the entire captured context.
_Avoid_: dashboard, viewer, TUI, frontend

**Snapshot**:
The whole record as it stands, sent to a viewer when it connects. Followed by a
live stream of everything after it, so opening the UI late or reloading it
loses nothing, and a viewer that falls behind re-snapshots rather than catching
up.
_Avoid_: backfill, replay, initial state
