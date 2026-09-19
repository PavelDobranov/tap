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

**Interim state, #14 — now closed by #15.** Payload capture landed before the
scheme did, so the record briefly held payloads exactly as this ADR says it
must not: verbatim, and quadratic in conversation length. That was deliberate
sequencing — there has to be evidence in the record before there is anything to
deduplicate — and `docs/measurements/raw-payload-capture.md` holds both
numbers: what verbatim capture cost, and what the scheme costs on the same
script.

**Settled by #15.** The two details this ADR said were hard to change later are
now decided.

*Key ordering* is **ascending by UTF-16 code unit** — JavaScript's own default
string sort, so `"A"` before `"a"` — with arrays left in their own order and no
whitespace anywhere. Chosen because it is the ordering a reader of the code
will assume and the one that needs no comparator to be written down correctly.

*Annotations* are cut textually rather than structurally. `cache_control` is
removed with the comma on whichever side has one, and the skeleton records the
offset it was cut at along with the text; putting it back is a splice.

One consequence was not anticipated and is worth writing down, because it is
invisible from the shape of the data. **A blob must not be a substring of its
payload.** In V8 a substring is a slice holding a reference to the string it
was cut from, so a blob taken straight out of a request pins that entire
request — the record deduplicates perfectly, reports a 120x ratio, and frees
nothing. Every string the record keeps is detached from the payload it was read
out of. The first run of the #15 measurement showed no improvement at all for
exactly this reason, which is the argument for measuring the scheme rather than
reasoning about it.

A blob therefore holds **the bytes that arrived**, with annotations cut out —
not the canonical JSON, which #15 asked for in as many words. Only one of the
two can be true: canonical bytes cannot be handed back to a reader who was
promised the payload byte for byte, and byte-exactness is the criterion that
matters. Canonical JSON keeps the job it was introduced for, which is deciding
what address a unit has, and the ticket's wording is corrected here rather than
followed.

Reconstruction being *textual* is what makes exactness cheap. A skeleton is the
bytes that arrived with holes in it, so filling the holes cannot introduce a
re-serialisation: no reordered key, no lost whitespace, no `1.0` that comes back
as `1`. Canonical JSON is used only to decide what two units' shared address is,
never to produce bytes a reader sees. So canonicalisation can only ever cost
deduplication, and a unit whose bytes would not match the blob already at its
address is simply left in the skeleton verbatim. That costs a duplicate, and it
shows: an unaddressed unit is never counted as a reference, so the reported
deduplication ratio falls rather than overstating a saving that is not there.

**Eviction is still absent.** ADR-0005 says the record is capped and evicts
oldest-first at blob level, and #15 built the blob map that eviction acts on
but not eviction itself — the epic notes it as scope with no ticket yet. The
32MB budget in capture still bounds any single body or response and never the
record as a whole. What has changed is that the uncapped thing is now 1.4 MiB
of payload for an 80-turn conversation rather than 119 MiB, so the gap is far
less urgent than it was; it is still a gap.
