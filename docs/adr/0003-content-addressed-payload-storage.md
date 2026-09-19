# Content-addressed payload storage

Every `/v1/messages` request resends the whole conversation, so holding
payloads verbatim is quadratic in conversation length — untenable for a record
that lives in memory for the whole of a session. Repeating units (the `system` block, the `tools` array,
and each element of `messages[]`) are extracted into a content-addressed blob
map keyed by SHA-256 of canonical JSON; what remains against the request is a
skeleton of hash references. Reconstruction is exact.

This **deliberately overrides** the original design document's instruction to
"preserve the raw payload, do not normalise". Fidelity is preserved; the
representation is not verbatim. It is recorded here precisely because it
contradicts an earlier stated principle, so that the contradiction reads as a
decision rather than a lapse.

## Consequences

Two details are hard to change later and so are decided up front. Claude Code
moves `cache_control` breakpoints between requests, which would make an
otherwise identical message hash differently and silently defeat
deduplication — `cache_control` and any other position-dependent annotation is
stripped before hashing and retained in the skeleton. And canonical JSON needs
a fixed key ordering: changing it later invalidates every stored blob.

The real deduplication ratio is unmeasured, and the UI should show it against a
real session before the scheme is trusted.

**Amended by ADR-0005.** The scheme survives the move to ephemeral in-memory
capture; only its justification changes, from unbounded growth on disk to
several gigabytes of RAM in a long session. Two details follow from the move:
blobs are not compressed, because they are read continuously by a live UI
rather than sitting cold; and the blob map is what eviction acts on, so a
single huge tool result can be dropped while the shape of the request that
carried it survives.
