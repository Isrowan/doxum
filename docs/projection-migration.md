# Projection Runtime API Changes

This change replaces the document-specific view factories with one explicitly
owned projection graph. It does not change canonical mutation ownership,
operation formats, history, or payload transfer rules. No application repository
migration or package publication is included.

## Collection Mapping

Create one projection per owning service, bind its documents, then map typed
collection sources:

```ts
import { createProjectionRuntime } from 'doxum';

const projection = createProjectionRuntime({ onError: error => console.error(error) });
const document = projection.document(runtime);
const tasks = document.collection(path => path.tasks);
const titles = projection.map(tasks, (_id, task) => task.title.get());
```

The previous standalone collection factory is removed. Collection sources are
cached by document/schema target identity, share one document subscription, and
can also be declared directly in a custom processor's sources. Mapping preserves
keys and order. Map accepts document collection sources and upstream projection
collections. Use a custom collection processor for filtering or joins.

## Values And Custom Collections

The previous materialized factory and its source metadata types are removed.
Use `projection.value(sources, compute, { isEqual }?)` for ordinary values,
`projection.value({ sources, build }, { isEqual }?)` for stateful values, and
`projection.collection<Item>()({ sources, build, isEqual })` for keyed output.

Value build returns `{ value, update }`. Update receives the declared source
contexts and returns `unchanged`, `changed(value)`, or `rebuild`. Equality is a
separate options argument inferred from the output, independent of property
order. Collection build/update receives `{ sources, previous, next, writer }`;
the item type is explicit and sources are inferred. A second type parameter
can constrain collection keys: `projection.collection<Item, Key>()(spec)`.

Document contexts expose scoped read, revision, reset and ordered commits.
Collection contexts additionally expose their bound target, `candidates.keys`
and `candidates.orderDirty`. These summarize every relevant commit in a batch;
check `reset` first and read final state. Candidates are not net output changes.
Upstream keyed nodes expose get/has/ids and `CollectionImpact`; ordinary values
expose value/previous/changed. No arbitrary materialized custom change payload
or automatic read-dependency learning remains. Fixed document targets can be
declared through `document.targets(...)`.

Private indexes remain processor-owned and must be rebuildable. Never publish
a Map that the processor will later mutate. Collection writers stage touched
keys and own final change generation; callers do not maintain public patches,
revision counters or drain/emit protocols.

## Behavioral Changes

- Value, ids, all, and item revisions reflect their own semantic output changes,
  independently of document revision. Equality preserves previous references.
- Collection mapping participates in the same settle-before-listener pipeline
  as custom materialized nodes. All attached graphs settle before notification.
- A failed update discards staged output and attempts one fresh build. Persistent
  faults make reads throw and block descendants; independent branches continue.
  Fault/recovery notifications may occur without changing the output revision.
- Manual rebuild drives downstream nodes through the same scheduler.
- Listener failures are isolated individually. Errors are sent to onError;
  synchronous document notifications also retain them in observerErrors. A
  failing onError is collected on document results or thrown as AggregateError
  after an independent flush. A batch callback's original error takes priority.
- Node disposal with live consumers is rejected. Disposed handles throw; they
  no longer silently retain values or accept inert subscriptions. Runtime
  disposal releases the whole graph. React unmount only unsubscribes.

## Multiple Sources

Use `projection.input(initial, { isEqual })` for application boundary values;
retain its set method at that boundary and give processors only its source.
Use `fromReadable` to attach an existing external readable without owning it.
Bindings share one external subscription but cache separately by readable and
equality function identity. Reusing a readable never silently ignores equality.
Release the projection before disposing an external readable.

Wrap document mutation and synchronous editor cleanup in `projection.batch`
before the first commit. Nested batches merge. Document commits, history and
document listeners stay synchronous; only projection settlement is deferred.
Projection reads inside a batch return the last published state. Exceptions do
not roll back already committed sources. Async callbacks are unsupported.

## Verification

Core tests include an explicit geometry/adjacency/route chain, hover membership,
100k mapped rows, source batching, recovery, disposal, and existing mutation and
local-sync regressions. React tests cover keyed rerendering, SSR and unmount.
`pnpm run bench` includes mapped-item and multi-source workloads; `pnpm run profile`
reports p50/p95/max latency, logical work counters and heap measurements. Heap
measurements describe retained/observed memory, not total allocation volume.
