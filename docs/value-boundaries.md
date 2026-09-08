# Value Boundaries And Mutation Performance

## Final API

| Capability                  | API                                                                    | Owner                                  |
| --------------------------- | ---------------------------------------------------------------------- | -------------------------------------- |
| Subtree value               | `snapshot(reader)` returning the corresponding `Infer`                 | Scoped reader and schema value copying |
| External value parsing      | `parse(nodeOrSchema, unknown)`                                         | Schema value traversal                 |
| Scalar validation           | `field(validator, { snapshot: copy }?)`                                | Field schema                           |
| Domain entity keys          | `map(entity, { key: validator })`, `table(entity, { key: validator })` | Collection schema                      |
| Scalar container validation | `dict({ key, value })`, `list({ keyOf, value })`, `tree(validator)`    | Container schema                       |
| Read-modify-write           | `fieldWriter.update(value => next)`                                    | Existing mutation session              |

Validator functions return the validated value or throw. Standard Schema v1
validators are also accepted. Only synchronous, value-preserving validation is
supported: defaults, coercion and other transformations belong before Doxum's
boundary. Parse throws ParseError containing an addressed issue and returns a
detached value on success. There is no async transaction or extra mutation
operation for callbacks.

Schema object members not declared in the shape are preserved as opaque extra
properties; declared required properties and variant tags are checked. Tables
must have unique ids matching byId exactly. Lists require unique string keys.
Trees retain the existing empty-or-single-root graph rules. Type-only fields
remain supported for trusted runtime use, but parse cannot assert their generic
type for an encountered unknown value and rejects them without a validator.

Snapshotting copies just the selected subtree at the time of the call, including
preceding uncommitted writes. The result survives rollback, scope expiration and
future commits. It is not a live reader or a memoized projection. Plain objects
and arrays are copied, as are supported mutable builtins. Classes/functions need
an explicit field snapshot copier. The copier is a contract to return an
independent equivalent value and must be synchronous. Runtime snapshot follows
the same copier rules. Field get retains the immutable atomic-payload contract.

Optional field updaters receive undefined when absent. A callback returns a
replacement value, never an operation or a draft protocol; use clear to remove
presence. Throwing or failing validation rolls back previous transaction work.
Updaters cannot make nested writes or return promises. History, prepare, impact,
local-sync and external observers see the same ordinary field.set operations.

## Ownership And Replacements

| Addition/change                     | Lifecycle                                    | Replaces                                              | Consumers                                          |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Address index                       | Runtime subscriptions or one commit          | First-segment buckets and repeated changed-path scans | Notification and impact                            |
| Deferred cancellation cleanup       | One notification                             | Unconditional full subscription scans                 | Notification                                       |
| Schema value traversal              | Schema configuration and each incoming value | Tree-only initial/replacement traversal               | parse, createDocument, replace, mutation/operation |
| Reader location and snapshot marker | Active read scope                            | Application subtree mapping and retained lazy readers | select, transactions, React selectors, projection  |
| Collection key parameter            | Schema configuration                         | Repeated hard-coded string keys                       | Access, selectors, impact, projection              |
| Field updater                       | Mutation session                             | Application read-plus-set boilerplate                 | Typed writer                                       |
| Compiled object accessors           | Schema node                                  | Per-object Proxy and child Map                        | Reader and writer                                  |

## Performance Verification

The reported test.mjs workload writes two numeric fields per updated entity,
disables retained history and measures 60 frames after 20 warm-up frames in
three trials. Its final case subscribes to the first 1,000 IDs but times updates
to IDs 2,000 through 7,999: the measured subscription workload has zero hits.
Before indexing, one such frame performed 1,000 affects calls and 400,000 path
prefix comparisons. The regression test requires both counts to be zero.

core/bench/mutation-frames.bench.ts separately covers zero, partial and full
subscription hits and compares read-plus-set with field update. Latency is
machine/JIT/GC dependent; algorithmic assertions protect unrelated-entity work.
The benchmark includes ordinary reversible commits, not a bypass around history
inverse generation or atomicity. Explicit projection batches defer projections,
not document commits or document listeners.

Measurements before the mutation-path refactor (Node v24.11.1, macOS,
milliseconds per frame):

| Entities | Updated/frame | Field subscriptions | Original read+set mean | Original read+set P95 | Field update mean | Field update P95 |
| -------: | ------------: | ------------------: | ---------------------: | --------------------: | ----------------: | ---------------: |
|    1,000 |         1,000 |                   0 |                   3.45 |                  3.85 |              2.80 |             3.54 |
|   10,000 |        10,000 |                   0 |                  47.76 |                 58.56 |             35.16 |            43.12 |
|   10,000 |           100 |                   0 |                   0.32 |                  0.34 |              0.25 |             0.26 |
|  100,000 |         1,000 |                   0 |                   3.62 |                  4.38 |              2.72 |             3.48 |
|   10,000 |           100 |               1,000 |                   0.34 |                  0.35 |              0.26 |             0.27 |

Both columns use the implementation before the mutation-path refactor. The second variant changes only
the two field increments to updater callbacks and removes the unused entity
reader. Counts, warmup, timing and correctness assertions stay the same. Both
variants ran sequentially in one process; ordering and GC can affect absolute
times. Before implementation, the local read+set subscription case averaged
7.31 ms. Full-document frame cost remains significant; this is not a claim
that 10,000 reversible entity updates fit a 60 Hz frame budget.

Validation completed with 166 tests across 13 files, format/lint/type checking,
package builds, benchmark and workload-profile suites. Published ESM/CJS smoke
tests exercise parsing, snapshots, field update, history and rejected payloads;
TypeScript fixtures check domain-key inference and invalid calls against package
exports. test.mjs received formatting only.

## Mutation Path Refactor

Typed fields validate and compare before allocating operations. External field
operations decode and normalize once, then use the same session field entry.
Operation publication and inverse ownership remain in mutation/operation;
field assignment remains in the shared executor. No callback operation, public
edit API, deferred canonical writes, or unvalidated equality shortcut is added.

The transaction retains one recent object/collection resolution prefix. Changed
structural operations invalidate it; variant and opaque-container traversal
is not retained. Pure field journals deduplicate by parent container and key,
then promote into the existing structural address tree on the first non-field
operation. Promotion discards the direct lookup. The old journal hash buckets
and inverse group/count arrays are removed. Writer children use indexed slots
instead of per-instance property installation; field methods bind lazily while
remaining safe to destructure. Collection impact no longer builds all field
paths, and impact consumes authoritative journal paths without an operation
fallback. Profiling remains available on the normal runtime path.

Final refactor measurements, same workload and sequential read+set then update
in one process (three trials, 20 warmup and 60 measured frames each):

| Entities | Updated/frame | Subscriptions | Read+set mean | Read+set P95 | Update mean | Update P95 |
| -------: | ------------: | ------------: | ------------: | -----------: | ----------: | ---------: |
|    1,000 |         1,000 |             0 |          2.68 |         4.69 |        1.47 |       1.68 |
|   10,000 |        10,000 |             0 |         29.57 |        38.48 |       21.22 |      26.59 |
|   10,000 |           100 |             0 |          0.22 |         0.24 |        0.14 |       0.15 |
|  100,000 |         1,000 |             0 |          2.39 |         2.77 |        1.72 |       2.04 |
|   10,000 |           100 |         1,000 |          0.24 |         0.25 |        0.16 |       0.16 |

The full update case improves by about 40% against the preceding 35.16ms
measurement. An intermediate standalone update run measured 18.32ms; the final
sequential result above includes process-order/GC effects and is the reported
comparison. The added nested benchmarks separately exercise unchanged writes,
collection impact, and affects. Their short runs measured 21.95ms for update,
12.51ms unchanged, 22.98ms collection-impact, and 29.47ms affects; these are
different sampling conditions from test.mjs. Full updates remain above the
16.7ms frame budget.

Regression coverage checks shared sibling resolution (five schema/document
steps for two four-segment addresses), no operation/inverse/subject allocation
for unchanged typed fields, validator execution on unchanged values, detached
methods and expired writers, delete/recreate with retained writers, mixed-batch
rejection, prepare rollback, variant absorption, history order, and collection
impact without descendant field indexing.

## Migration

Malformed document structures that were previously accepted at initialization
or replacement now fail early. Configured validators also apply to later writes
and history replay, so validators must be deterministic and stable for the schema
lifetime. External transforms must be completed before entering Doxum. Opaque
fields need copiers when snapshotting their subtree. A domain key is a string
subtype; runtime distinction requires a validator with real domain rules.

No consumer repositories are changed. No compatibility wrappers, secondary
write caches, automatic projection dependency tracking or callback operation
payloads are introduced.

The obsolete first-segment `target.bucket` helper is removed; target matching
uses the complete schema address and optional entity ID.
