# Runtime Invariants

Public call shapes belong in [api.en.md](api.en.md); keep this file limited to
implementation invariants that affect design and review decisions.

1. createDocument owns canonical state; Draft, apply and replace share MutationSession.
   runtime owns one execution/rollback/seal/publish boundary, also used by history.
   mutation/operations groups table/list/order/tree/replay commands by domain; session
   owns the write kernel. Scope binds already-resolved facts through session and
   reuses handles within a generation. These are internal implementation boundaries.
2. Updates and public reads are synchronous and scoped. Reentrant writes are forbidden.
   Failure restores all earlier work. Ordinary exceptions rethrow; TransactionRejected
   returns application issues. Internal readWith creates a borrowed reader; its
   proxies and collection methods must not escape the synchronous callback.
3. mutation/changes.ts decodes unknown ChangeSets once. Schema resolution is authoritative.
   Reject overlapping parent/child facts and duplicate groups. Each container group
   installs its members then its optional order; no standalone order records.
4. ChangeRecorder groups first-touch members by container and owns order baselines and touched tree nodes.
   Ordered groups publish members and order together; tree containers have no member
   layout and cannot accept ordinary members replay. Tree commands capture nodes directly.
   Rollback runs no user callbacks or validators. Seal publishes net differences.
   Capture, restoration and per-domain sealing stay separate. Copy final order only
   after comparing current keys; keep the rollback baseline even for a net-zero edit.
5. Atomic equality is Object.is; canonical structure retains atomic references under
   ownership contract. Snapshots copy structure and share readonly payloads, as do
   commits and history. No payload cloning or publication freezing. Validators receive
   original inputs and must be pure; function validators are predicates/assertions and
   Standard Schema success may not transform the canonical value.
6. List identity is a stable key; replacement retains it. Anchor owns ordering.
   Tree owns reciprocal, connected, acyclic, empty-or-single-root topology.
7. Public `Schema` / `ObjectSchema` handles own schema identity while concrete nodes stay
   internal; one RuntimeContext owns instance identity for the runtime, history and
   `document.readonly()` aliases. The shared path compiler and Core impact target
   algorithms own addressing/identity/equality/bucketing and exact matching. React sees
   only Readable/select contracts. Notification matches grouped changes directly without
   building commit impact indexes.
8. Apply requires expectedRevision and captures actual local old state. Local reset is
   reversible; remote commits invalidate history. Groups travel in one session.
9. Projections declare producer sources and settle before listeners. The producer DAG
   remains static. `derive.keyed` declares extra sources in one named dependency object;
   `{ source, key }` members may bind each output key to a key in an explicitly declared
   keyed source. The materialized Runtime owns those bindings and reverse indexes,
   including bindings to currently missing source entries. Processors do not create graph
   dependencies through imperative Runtime reads. A scope adds lifecycle ownership only
   through `scope.own`; scoped definitions may depend on root definitions, while root and
   sibling scopes cannot depend on scoped definitions. Notification failures leave commits
   accepted. Batch defers projection publication, not document commits/listeners.
10. Local sync uses Web Lock leadership and contiguous durable sequence. Writes precede
    asynchronous persistence. Version 5 / format 3 rejects old databases without editing
    them. External replace and remote apply are prohibited while attached.
11. Core is framework-neutral. Public exports are deliberate; root dist is generated.
12. Test malformed input, partial rollback, history, impact, disposal and bounded work.
    Delete obsolete APIs and parallel protocols.

Network intent, authorization, collaborative undo and persist-before-visible acceptance
are separate requirements, not hidden runtime capabilities.
