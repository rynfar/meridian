---
id: session
type: module-design
status: active
title: Sessions, lineage and bookkeeping
parent: architecture
depends-on: [telemetry-ui]
---

## Responsibility

Map each client conversation to a Claude SDK session and decide, per request,
whether the incoming history can **resume**, **fork** or must **replay**:

- lineage verification (continuation / compaction / undo / diverged) over
  structured v2 hashes;
- the in-memory session and fingerprint LRUs and the durable shared store that
  lets another proxy process resume the same conversation;
- turn serialization (in-process and cross-process), transcript publication
  leases and transcript garbage collection;
- the optional SQLite bookkeeping backend (`bookkeeping/`) and its offline
  `meridian-bookkeeping` maintenance CLI.

Code: `src/proxy/session/`, plus `sessionStore.ts`, `sessionLifecycle.ts` and
`executionHistory.ts` beside it.

## Boundary

- `lineage.ts` is **pure**: hashing and comparison only — no I/O, caches or
  server/cache imports; testable without mocks. `interruptedTurn.ts` (the
  interrupted-turn decisions below) is pure in the same way.
- `cache.ts` **owns all mutable session state**; no other module creates
  session LRUs.
- Never imports `server.ts`, adapters or provider backends. It may use the
  leaf `messages.ts`, `utils/lruMap.ts` and telemetry diagnostics.
- Lineage proof is the **original client history**; plugin-modified execution
  history may change what the SDK runs but never proves a resume.
- When it cannot prove the SDK session contains a section of client history,
  it starts fresh and replays — it never silently skips history.
- The Antigravity backend never uses this module; the ChatGPT backend reuses
  only its durability primitives (`durableFileSystem`, `processIncarnation`,
  `recoveryClaim`).
- JSON bookkeeping is the default; `MERIDIAN_BOOKKEEPING=sqlite` is explicit and
  a SQLite directory never falls back to JSON.
- JSON durable mutations serialize per store path in invocation order and return
  promises. Callers await completion before reading their result or releasing
  publication ownership. Inputs are owned before the first yield, and the
  publication guard is checked immediately before rename. SQLite mutations and
  their commit continuations stay synchronous inside an admitted transaction;
  `storeMutationResult.ts` preserves that distinction. Cache clear resets memory
  immediately and again at the ordered durable commit, before the next writer.
  Successful eviction also invalidates its local cache after commit, so a read
  during a JSON write cannot repopulate a fallback entry that outlives eviction.
- A prompt-cache keepalive beat (see `proxy-core` → Decisions) only **reads**
  a published mapping: it resumes the mapping's current transcript as a
  non-persisted fork, takes no writer or publication lease, and never
  publishes, invalidates or reclassifies anything. The session's mapping,
  transcript and lineage are byte-identical before and after a beat. The
  source transcript is pinned against this process's GC until the beat's
  child is joined; collectors in other processes ignore that private pin, but
  the published mapping retains the source, and if another process retires it
  anyway the beat only fails and is retried or stopped.
- Transcript GC here is the only Meridian-owned transcript deletion. Opt-in
  transcript retention (`proxy/transcriptRetention.ts`, off by default) hands
  Claude Code's own cleanup a period; that cleanup is outside this module's
  leases and pins and may retire a mapped transcript by age, after which the
  conversation replays (see `architecture` → *Transcript publication
  lifetime*).

Detailed contracts live in [`architecture`](../../../ARCHITECTURE.md): *Session
Management*, *Lineage Verification*, *SQLite bookkeeping boundary*, *Transcript
publication lifetime*, *Session store write cost*, *Lineage hash encoding* and
*Appended content and transient hooks*.

## Interrupted turns

A client that stops a streaming turn after output reached it (Stop, Esc, a
closed socket or a cancelled response body) leaves the session that turn
resumed exactly where it was: every resume writes an isolated managed fork, so
the source transcript still ends at the last completed turn. Whether that
session may be resumed depends on what the client did with the partial
output, which only its next request shows:

- **Discarded** (Pi 1.4 and Prime Agent 0.9.5 skip `stopReason: "aborted"`
  assistant messages; Oh My Pi drops a thinking-only one). The next request
  keeps the stopped user message and appends a new one, or resends the stopped
  request: after the stored prefix and the session's own reply it carries only
  user content (the real Pi 1.4.0 client, after its RPC `abort`, sent
  `…, assistant, user(stopped), user(new)`, plus its trailing `system`
  updates). Resuming then gives the model exactly the history the client
  holds, with the prompt cache.
- **Kept** (OpenCode, and Oh My Pi when the partial has text or a tool call,
  with a synthesized aborted result). The next request carries an assistant
  message the session never received (the real OpenCode 2.2.0 client, after
  `POST /api/session/:id/interrupt`, sent `…, user(stopped), assistant(partial
  text), user(new)`). Resuming would deliver only the user's
  side of it, so the model would answer without the output the user saw: a
  silent divergence, which is the failure this rule exists to prevent.

So the stopped turn's mapping is kept but marked interrupted, and the next
request is decided by `classifyInterruptedContinuation` (`interruptedTurn.ts`):
resume only when it keeps the stored prefix and the session's reply intact and
adds no assistant message (text, thinking, a tool call or an empty one) and no
tool result for a call the session never made. Anything else replays fresh, as
an evicted mapping would, with the check's verdict on the request line
(`diverged=interrupted-turn-kept:<reason>`). One request decides the record;
it is cleared either way. A side request that shares the key never takes it.

Marking applies only to a plain continuation that resumed the published
session it read, stopped by the client's own disconnect or body cancel before
any tool call reached the client. A turn that streamed a tool call, an
explicit subtree cancel (`POST /v1/sessions/:key/cancel` or a parent's abort),
the turn watchdog, shutdown, a published fork, a non-stream turn, a side
request and a priority publication keep their existing handling. For a
priority publication that handling leaves the routed mapping as the durable
route recorded it, so its next turn resumes the source whatever the client
kept (see *Known limitations*).

A turn that retried onto a fresh session (a refused resume or a model
fallback) is not that session's continuation either. The retry runs only
before anything reached the client, and it evicts the mapping before it
replays, so a marking would fail the store's generation check anyway. The
fork check that also refuses it (`forkStillCopiesCandidate`: a fresh target, a
superseded fork or a fork of another session) is therefore defensive: no
current path reaches it with a markable mapping.

**Storage.** The durable record keeps its session, transcript locators and
hashes, but its SDK reuse proof is withheld: an empty `lineageHash` with the
hash kept as `clientLineageHash`, the existing "lineage owned, resume
unproved" encoding that every reader, old or new, answers with a fresh replay.
What restores the proof after the check — the prefix and its hash, the
reply's message hashes and tool ids, and the exact generation the marking
wrote — lives only in the marking process's memory (`cache.ts`). Persisting a
marker field was rejected: the SQLite mapping codec refuses unknown fields,
so an older reader sharing the store would fail on the key, and a reader that
ignored such a field would resume without the check. Not keeping the mapping
at all was rejected too: an evicted source becomes collectable, and a
process-local copy would have to resurrect it outside the store's generations.
A restart, another process or a store write by anyone else therefore costs
one replay, never a resume without the check.

The marking is a mapping write by the stopped turn itself. A keyed request
that arrived before it and waited for the turn lease is not treated as having
lost a commit race. The marking completes before the stopped stream does, so
for keyed requests the turn lease never lets the next request read the
mapping before it. What holds that today is the order inside the body's
`cancel()`: it aborts the request synchronously and only then starts the
marking, so the pipeline sees the abort (its SDK iterator rejects, or its
check before the terminal frames throws) and its catch settles through the
same shared marking, awaiting it before `finally` runs. The catch skips
settlement only for an error with no abort, and that path reaches `finally`
with no await at which `cancel()` could start a marking, except on the
tool-recovery branch, which ends an aborted turn by evicting the mapping.
The stream's `finally` awaits a pending marking as well. No current path needs
that second wait, and no test can observe it (with a 150 ms marking delay
injected, removing it leaves every test green); it stays as a guard, so that
a terminal path added later cannot release the lease before the marking lands.

A headerless (fingerprint-keyed) conversation takes no turn lease, so a
request that arrives during the stopped turn's cleanup can read the mapping
before the marking, as it can read it before the eviction main performs
there. It is then answered from the unmarked source as an ordinary
continuation, so a client that kept the partial is answered without it. If
the marking lands first, that request's publication fails the store's
generation check (its answer is still delivered), and since the marked
session lacks that answer, the check replays the next request. If its
publication lands first, the marking fails and the publication stands. Both
outcomes are main's, with the eviction in place of the marking.

A prompt-cache keepalive stops tracking the session at the client abort, as
before; a later turn that writes the one-hour tier tracks it again.

## Regrouped user messages

A client may regroup its user messages between requests without changing
what it claims: split or merge consecutive user messages, or drop or add a
user message holding only system reminders. Oh My Pi does the last when an
idle rebuild adds an eval-state note that its session file never keeps; after
a restart the note is gone and every later message shifts by one. Positional
lineage then stopped at the note and replayed the whole history (2026-11-07:
767 messages, a 409K-token cache write).

Consecutive user messages reach the SDK as one input (`getLastUserMessage`,
`coalesceStructuredUserMessages`), so its transcript never held those
boundaries, and `stripSystemReminders` already keeps reminder text out of
lineage identity. After the fast path misses, and before any suffix-based
verdict (a regroup near the end would read as a client compaction),
`verifyLineage` realigns the stored history (`alignRegroupedUserRuns`,
pure): across each incoming run of consecutive user messages, the stored
messages' block hashes must equal the run's in order, skipping blocks that
are empty once reminders are stripped; a stored reminder-only message before
a non-user message may be dropped. Both sides must sit on a message boundary
after the run.

The realigned session is the stored one in incoming positions: hashes from the
request through the realigned span and stored ones after it, SDK UUIDs moved
with their messages. It is classified as usual, so a full realignment resumes
as a continuation and a partial one can still undo at a moved assistant UUID.
The lineage proof is rebuilt only for a full realignment (in the encoding the
stored mapping used, so an interrupted mapping keeps its withheld proof);
every position-indexed field (`resumeFrom`, `prefixOverlap`, UUIDs,
`messagesHeld`) is then in incoming positions. The plugin `onSession` contract
is unchanged; its counts and mismatch index are in the realigned positions.

Still a divergence: an edited, reordered or moved block (including across an
assistant turn), a dropped user message with real text, a hash-ignored block
(thinking) in the run, a message with no blocks, text appended to the stored
history's last user message, a session without block hashes, and a run that
ends the request (a resent turn keeps its verdict). A reminder with any other
text beside it, even a newline, is content.

## Known limitations

- **Container host identity.** Inside containers the derived `hostId` changes on
  restart, and containers built from one image share a baked `machine-id`, so
  stale or foreign store locks can wedge requests. Workaround:
  `MERIDIAN_HOST_ID` (see `docs/configuration.md` → *Known limitations*).
- **Boot identity is required.** Without a host boot identity Meridian refuses
  to start (escape hatch `MERIDIAN_ALLOW_MISSING_BOOT_IDENTITY=1` still cannot
  serve).
- **An interrupted turn resumes only in the process that kept it.** After a
  restart, or on another process sharing the store, the next request replays.
- **A stopped priority-routed turn is not checked.** Under priority routing
  across several profiles, a conversation whose client signs its turns
  (OpenCode's V2 plugin, Pi's extension) has a durable route, and its turns
  are priority publications, which the interrupted-turn rule skips. A stopped
  turn there leaves the routed mapping resumable with its proof, as main
  does, so a client that kept the partial (OpenCode) has its next turn
  resumed without it. Applying the check to priority publications is a
  follow-up.
- **Mixed proxy versions replay.** v1 lineage digests cannot prove a v2 prefix,
  so alternating old and new proxies repeats a full-history replay until every
  participating proxy is upgraded.
- **Editing a primary agent's instructions without switching agents** stays
  subject to the native resume limitation (the SDK restores its original system
  prompt).
- **A conversation returning to a pruned profile copy replays** instead of
  resuming (only with `MERIDIAN_SESSION_PROFILE_COPY_PRUNE=1`).
- **Windows writer-lease recovery** for a crashed proxy waits for a host reboot,
  because an executor's death does not prove its descendants gone.
- **Retention cleanup can race a resume** (only with opt-in transcript
  retention on). Claude Code's cleanup runs a few seconds after a request
  child starts, in any child sharing the config root, and deletes by mtime
  alone. A conversation idle for longer than the period whose resume is
  loading its transcript while a concurrent cleanup deletes it can lose its
  SDK-side history: the child keeps what it already read but appends to a new
  file without the earlier turns, so a later resume silently lacks them and
  lineage cannot detect it. A conversation
  whose transcript is already gone is refused and replays from client
  history instead. A pin-aware cleanup is a recorded follow-up (`proxy-core`
  → *Decisions*).
