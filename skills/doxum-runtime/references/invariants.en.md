# Runtime Invariants

1. createDocument owns canonical state; Draft, apply and replace share MutationSession.
2. Updates and reads are synchronous and scoped. Reentrant writes are forbidden.
   Failure restores all earlier work. Ordinary exceptions rethrow; TransactionRejected
   returns application issues.
3. mutation/changes.ts decodes unknown ChangeSets once. Schema resolution is authoritative.
   Reject overlapping parent/child facts. Install values/topology then final orders.
4. ChangeRecorder owns first-touch values, order baselines and touched tree nodes.
   Rollback runs no user callbacks or validators. Seal publishes net differences.
5. Atomic equality is Object.is; canonical structure retains atomic references under
   ownership contract. Snapshots detach values. Structures follow schema equality.
6. List identity is a stable key; replacement retains it. Anchor owns ordering.
   Tree owns reciprocal, connected, acyclic, empty-or-single-root topology.
7. ObjectNode owns schema identity; runtime owns instance identity. Shared path compiler
   and impact-target own addressing/identity/equality/bucketing, including React.
8. Apply requires expectedRevision and captures actual local old state. Local reset is
   reversible; remote commits invalidate history. Groups travel in one session.
9. Projections declare sources and settle before listeners. Notification failures leave
   commits accepted. Batch defers projection publication, not document commits/listeners.
10. Local sync uses Web Lock leadership and contiguous durable sequence. Writes precede
    asynchronous persistence. Version 3 / format 1 rejects old databases without editing
    them. External replace and remote apply are prohibited while attached.
11. Core is framework-neutral. Public exports are deliberate; root dist is generated.
12. Test malformed input, partial rollback, history, impact, disposal and bounded work.
    Delete obsolete APIs and parallel protocols.

Network intent, authorization, collaborative undo and persist-before-visible acceptance
are separate requirements, not hidden runtime capabilities.
