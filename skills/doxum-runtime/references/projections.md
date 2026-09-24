# Doxum Projections

Use this reference for projection ownership, source boundaries, pure derive, keyed derivation, dynamic keyed dependencies, Runtime/scope lifecycle, selector tracking, batching, advanced processors, and recovery. Exact signatures are in [Public API](public-api.md).

## What a Projection is

`Projection<T>` and `KeyedProjection<K,V>` are lazy definitions. They do not themselves own current materialized values, subscriptions, retained state, source attachments, or disposal state.

One `ProjectionRuntime` materializes definitions and owns:

- producer/output state;
- dependency graph settlement;
- source subscriptions;
- projection revisions/listeners;
- retained advanced state;
- dynamic keyed dependency bindings;
- `runtime.items(...)` caches;
- error recovery and disposal.

Root projection definitions can be reused by multiple runtimes. Runtime-local state lives in each materialization, not on the definition object.

## Choosing the projection shape

Use the simplest public primitive that owns the required semantics:

| Requirement                                         | Primitive                                      |
| --------------------------------------------------- | ---------------------------------------------- |
| Pure scalar/aggregate result from named projections | `derive({...}, compute)`                       |
| One keyed source owns output keys/order             | `derive.keyed(source, selector)`               |
| Same keyed driver plus global/per-key joins         | `derive.keyed(source, dependencies, selector)` |
| Ordered keys as scalar array                        | `derive.keyed.keys(source)`                    |
| Ordered values as scalar array                      | `derive.keyed.values(source)`                  |
| Ordered `[key,value]` tuples as scalar array        | `derive.keyed.entries(source)`                 |
| Current scalar key selects one keyed entry          | `derive.keyed.get(source, keyProjection)`      |
| Ordered scalar/static collection becomes keyed      | `derive.keyed.from(source, keyOf)`             |
| Multiple keyed sources become one keyed union       | `derive.keyed.merge(sources, options)`         |
| Select requested ordered subset                     | `derive.keyed.subset(source, orderedKeys)`     |
| Preserve source values but filter membership        | `derive.keyed.filter(source, predicate)`       |
| Map entry and drop `undefined` results              | `derive.keyed.compact(source, selector)`       |
| Reverse index/group membership                      | `derive.keyed.groupBy(source, selector)`       |
| Optional scalar becomes 0/1 keyed collection        | `derive.keyed.singleton(source, keyOf)`        |
| Runtime-local scalar state                          | `input(initial)`                               |
| Runtime-local keyed state                           | `input.collection(initial?)`                   |
| Stable per-membership item readables                | `runtime.items(keyedProjection)`               |
| Retained state per driver key                       | `incremental.keyed`                            |
| Custom collection patching/shared retained state    | `incremental.collection` / `incremental.group` |

Do not implement a second join/cache/invalidation layer in application code when one of these primitives already owns it.

## Source declarations

`observe` is the single projection source declaration family.

### Document sources

```ts
const whole = observe(document);
const rows = observe(document, path => path.rows);
const title = observe(document, path => path.title);
const row = observe(document, path => path.rows.item(rowId));
```

Document map/table/list selections become keyed projections. Atomic array-valued fields remain scalar projections.

Tree paths reuse the same model:

```ts
const rootId = observe(document, path => path.outline.rootId);
const nodes = observe(document, path => path.outline.nodes);
const node = observe(document, path => path.outline.nodes.item(nodeId));
```

`rootId` is scalar, `nodes` is keyed, and `item(id)` is scalar `node | undefined`.

### Readable and external sources

```ts
const fromReadable = observe(readable);
const fromExternalValue = observe(externalValueSource);
const fromExternalCollection = observe(externalCollectionSource);
```

External source contracts are documented in [Integrations](integrations.md). Source events are normalized before processors run.

## Pure scalar derive

Use named dependency objects:

```ts
const summary = derive(
  { rows, filter },
  ({ rows, filter }) => summarize(rows, filter),
  optionalEquality
);
```

Dependencies are explicit and static. The compute callback may not return a Promise. Equality defaults to `Object.is` and compares the generated scalar result.

Do not call `runtime.read(...)` from a derive callback to discover dependencies. That would create an imperative dependency protocol outside the producer graph.

## `derive.keyed`: driver-owned membership/order

```ts
const labels = derive.keyed(rows, (row, rowId) => format(rowId, row));
```

The driver keyed projection owns output membership and order. Only invalidated driver keys execute the selector. Per-entry equality suppresses `updated` publication when the selected value is equal, while driver add/remove/order semantics remain intact.

The selector receives `(value, key)` and returns the output value for the same key.

### Global and dynamic keyed dependencies

```ts
const cards = derive.keyed(
  items,
  {
    density,
    metadata: { source: metadataByItemId },
    record: { source: records, key: item => item.recordId },
    related: { source: records, keys: item => item.relatedRecordIds },
  },
  (item, itemId, { density, metadata, record, related }) =>
    renderCard(itemId, item, density, metadata, record, related)
);
```

Dependency forms:

- ordinary `Projection<T>`: global dependency; when it changes, relevant driver work is invalidated as a whole;
- `{ source }`: same-key lookup; driver key directly selects the source key and resolves to `V | undefined`;
- `{ source, key }`: singular driver-key → source-key binding; resolved value is `V | undefined`;
- `{ source, keys }`: ordered duplicate-free driver-key → source-keys binding; resolved value is `ReadonlyMap<K,V>` in requested-key order, containing currently present entries only.

The same-key form requires `DriverKey extends SourceKey`; this preserves branded-key safety while allowing a narrower driver domain to read a broader source domain. It has no selector or relation map: source entry changes invalidate the driver entry with the same key directly. The Runtime owns forward binding and reverse invalidation for mapped forms. A missing selected source entry still keeps the binding, so a later source add invalidates the dependent driver key correctly.

Source-only order change does not invalidate same/singular/plural keyed lookup because dependency identity is by selected key, not by source-global order.

`keys(...)` selectors must return duplicate-free key arrays. Treat duplicate keys as invalid input rather than as a hidden deduplication feature.

## Structural keyed reads

### Keys

```ts
const ids = derive.keyed.keys(rows);
```

The scalar result follows formal keyed membership order. Value-only updates do not change the published array reference or projection revision. Add/remove/order/reset can publish a new array.

### Values

```ts
const values = derive.keyed.values(rows);
```

Values follow formal keyed order. Value-only updates publish when the corresponding entry value changes.

### Entries

```ts
const entries = derive.keyed.entries(rows);
```

Produces ordered readonly `[key,value]` tuples. Value-only updates publish correctly. Unchanged tuple objects are reused where possible, so consumers do not need a manual `derive.keyed(... => [key,value])` plus values stage.

### Precise scalar lookup

```ts
const active = derive.keyed.get(rows, activeId);
```

`activeId` is a scalar `Projection<K | undefined>`. The derive binds exactly the selected key. If the key is absent, the result is `undefined` while the binding remains live for later add.

Use this for active entity, editor target, selected record, or current-cell lookups.

## Keyed construction and composition

### `from`

```ts
const rows = derive.keyed.from(rowArray, row => row.id);
const projectedRows = derive.keyed.from(rowsProjection, row => row.id);
```

`source` is either a static readonly array or `Projection<readonly V[]>`. `keyOf(value)` defines stable member identity and must return a unique string key. The output formal order is exactly the input array order. Duplicate keys are processor errors; Doxum never silently overwrites or deduplicates them.

Static outer arrays are shallow-snapshotted when the definition is created, while `keyOf` remains lazy until materialization. A scalar array projection has no per-entry delta, so every scalar publication is scanned. Output publication is still exact: same-key equality-equivalent values retain the previous published value identity, and reorder-only updates publish order without inventing value updates.

### `merge`

```ts
const effective = derive.keyed.merge([base, overrides], {
  conflict: 'last',
});
```

`merge` accepts a fixed definition-time list of `KeyedProjection<K,V>` sources. Membership is their union. Conflict policy is required:

- `error`: overlapping keys are processor errors;
- `first`: earliest source wins;
- `last`: latest source wins;
- `resolve`: for true conflicts only, call `resolve(contributions, key)` with source-priority `{ sourceIndex, value }` contributions.

A single contribution always passes through without invoking the resolver. Equality compares the final effective value and defaults to `Object.is`.

Formal merged order is always the stable first occurrence from concatenated source orders: `stableUnique(S0.ids() ++ S1.ids() ++ ... ++ Sn.ids())`. Value winner and position are therefore independent. For base + sparse overrides, `{ conflict: 'last' }` changes shared values without moving their base positions; override-only keys are also valid union members. If an override disappears while base still contains the key, the merged membership lifecycle remains continuous and `runtime.items(merged).get(key)` keeps the same current membership identity.

Value-only source changes only recompute affected keys. Structural or source-order changes may rebuild merged formal order. Present `undefined` remains a valid value because membership is determined by `has(key)`, not by `get(key) !== undefined`.

## Membership-changing keyed primitives

### `subset`

```ts
const visibleRows = derive.keyed.subset(rows, orderedVisibleIds);
```

Output order is `orderedVisibleIds ∩ source membership`. Missing requested ids remain latent and appear later if the source adds them. Duplicate requested keys are invalid. Values are source values and are not re-derived.

Use `subset` when another projection or static array already owns the requested order.

### `filter`

```ts
const visible = derive.keyed.filter(rows, row => row.visible);
```

Preserves source values and source-relative order. Because values are reused directly, there is no output-value equality parameter. Dynamic dependencies can be supplied with the same named keyed-dependency protocol as ordinary `derive.keyed`.

### `compact`

```ts
const content = derive.keyed.compact(cards, card => card.content || undefined);
```

`undefined` means output absence. Present selected values can use optional per-entry equality. Use when membership depends on a mapped optional result rather than a boolean predicate.

### `groupBy`

```ts
const recordsBySection = derive.keyed.groupBy(records, record => record.sectionIds);
```

Selector returns one group key or a readonly group-key array. Output is `KeyedProjection<GroupKey, readonly SourceKey[]>`. Each group's members follow source formal order. The Runtime incrementally maintains reverse membership for added/updated/removed/order/reset.

Group-key output order is also defined. Rank each group by the pair `(firstSourceIndex, selectorIndex)`: `firstSourceIndex` is the position of the earliest current source member that belongs to the group, and `selectorIndex` is that group's position in the selector result for that earliest member. Groups therefore follow first appearance in formal source order; when several groups first appear on the same source member, they follow the selector's returned group-key order for that member. If source order or membership changes, group keys may reorder according to the newly computed ranks.

Use this for domain-neutral reverse indexing such as record→sections, node→edges, group→item ids. Keep domain names outside Doxum itself.

### `singleton`

```ts
const activeEntity = derive.keyed.singleton(activeRecord, record => record.id);
```

Input is `Projection<V | undefined>`. `undefined` becomes empty membership; a present value becomes exactly one keyed entry.

## Runtime read/select

```ts
const current = runtime.read(projection);
const readable = runtime.select(projection);
const selected = runtime.select(projection, value => selectPart(value), equality);
```

`read` returns the current published projection value and materializes the producer if needed.

`select(projection)` returns a `Readable` for the whole value. Selector form tracks the relevant keyed reads/structure when the source is keyed, so unrelated keyed updates need not rerun the selector. If an invalidation is relevant, the selector reruns and result equality decides publication.

## Runtime-owned keyed item family

```ts
const family = runtime.items(rows);
const orderedKeys = family.keys;
const rowReadable = family.get(rowId);
```

Semantics:

- `keys` is a `Readable<readonly K[]>` for formal ordered membership;
- `get(key)` returns `Readable<V | undefined>`;
- while a key continuously exists, repeated `get(key)` returns stable readable identity;
- value-only updates notify the current item's readable without creating a new membership lifecycle;
- removal ends the current membership lifecycle and releases its cached item readable when no longer retained by the family;
- re-adding the same key creates a new membership lifecycle and may return a new readable identity;
- a requested missing key can remain latent and activate when the source later adds it.

Use this instead of adapter/business code subscribing to keys and maintaining its own `Map<K,Readable<V>>`.

### One-to-many keyed expansion

```ts
const lines = derive.keyed.flatMap(orders, order =>
  order.lines.map(line => [line.id, line] as const)
);

const errors = derive.keyed.flatMap(
  forms,
  { rules, fields: { source: fieldsById, keys: form => form.fieldIds } },
  (form, formId, dependencies) =>
    validateForm(form, dependencies).map(
      error => [JSON.stringify([formId, error.fieldId, error.code]), error] as const
    )
);
```

The synchronous selector returns a finite readonly array of readonly `[outputKey, value]` tuples. The output is a `KeyedProjection<OutputKey, Value>`. Both overloads accept optional per-entry equality as the last argument. Named global and dynamic same/one/many keyed dependencies use the existing driver-key protocol. Callbacks stay value-first.

Output order concatenates each parent's returned key sequence in formal parent order. Only invalidated parents run the selector on a normal successful update; parent order-only changes run no selectors. A global dependency may invalidate every parent. Membership or order changes may rebuild the complete formal output order: selector locality does not imply every operation is O(changes).

Output keys must be globally unique strings. Duplicate keys within a parent or across final parent results are processor errors, never silent overwrites. Use an unambiguous application key encoding for locally unique child IDs; there is no default delimiter or generated index identity. For identity across parent transfers, use a global child ID independent of the parent. `[]` means no members; `[[key, undefined]]` means a present member with an undefined value.

Equality defaults to `Object.is` and only controls an existing key's value update, preserving the previous published reference when equal, including reset/recovery. It cannot suppress membership or order. If one global key moves between parents in a single settlement, its final membership is continuous and `runtime.items(...).get(key)` retains its identity. A real removal in an earlier settlement ends that membership.

Selector/key-construction, tuple validation, duplicate-key and equality failures publish no partial collection and use normal processor recovery. Recovery can rerun selectors for all parents, so selectors must be pure. A persistent fault blocks dependents and reads throw until recovery. Definitions are lazy and reusable; caches are isolated per Runtime and released with their owner. Derive additional keyed views from the result normally. Async loading, recursive traversal and dynamically creating projections are outside this primitive; retained spatial/search indexes still belong in advanced processors.

## Projection inputs

Scalar local state:

```ts
const filter = input<'all' | 'open'>('all');
runtime.update(filter, 'open');
```

Keyed local state:

```ts
const selection = input.collection<RowId, boolean>();
runtime.update(selection, draft => {
  draft.set(rowId, true);
  draft.remove(previousId);
});
```

Inputs belong to one materializing Runtime/scope. They are not canonical document state and do not participate in document history, ChangeSets, local-sync durability, or document impact.

`input.collection` edit callbacks are synchronous borrowed sessions. If the callback throws, nothing is installed. Entry equality is also evaluated before the next local state is formally installed; if equality throws, published state and the next edit baseline remain unchanged.

An equality-equivalent `set` retains the latest accepted value reference; candidates equivalent to the published baseline reuse its reference. See Batch source reads for net-change and exception rules.

## ProjectionScope

```ts
const scope = runtime.scope();
const localFilter = scope.own(input('all'));
const visible = scope.own(derive({ rows, localFilter }, ...));
scope.read(visible);
scope.dispose();
```

A scope adds lifecycle ownership only. It shares the parent's scheduler/materialization system.

Rules:

- define projections through the ordinary root declaration APIs;
- call `scope.own(projectionOrStaticTree)` before that definition is first materialized as a root;
- a scoped definition may depend on root definitions;
- root definitions and sibling scopes may not depend on a scoped definition;
- the same definition cannot belong to two scopes;
- `scope.items` has the same membership/readable semantics as `runtime.items` and ends with scope disposal.

## Batching

```ts
runtime.batch(() => {
  runtime.update(filter, 'open');
  document.update(...);
}, { cause });
```

Projection batching defers projection graph settlement/listeners until the batch completes. It does not delay or roll back canonical document commits or document listeners.

Reads of projections inside the batch see the last published projection state, not an eagerly settled draft. Batch the whole application action before its first source update when one settled projection publication is required.

There is no cross-document transaction or rollback implied by `runtime.batch`.

### Batch source reads

`runtime.read(projection)` and `Readable.current()` always return published state. Outside a batch, a successful input update settles synchronously, so ordinary commands can use `runtime.read`. Inside `runtime.batch(read => ...)`, the supplied `read` reads the most recently accepted value of an `Input` or `CollectionInput` without settling the graph:

```ts
const count = input(0);
const doubled = derive({ count }, ({ count }) => count * 2);

runtime.batch(read => {
  runtime.update(count, read(count) + 1);
  runtime.update(count, read(count) + 1);
  read(count); // 2
  runtime.read(count); // 0: last published value
});
runtime.read(doubled); // 4
```

Use the same reader for commands spanning several independent inputs. Values entirely determined by other sources belong in `derive`, not in a manually synchronized input. Scalar updates always assign their second argument, including function values; there is no updater-function overload.

The reader only accepts inputs, never derived or observed projections. It belongs to its callback and Runtime/scope: it expires on return, throw, or a rejected asynchronous return, and cannot be reused by a later batch. Nested callbacks have separate readers; the outer reader remains valid and sees successful inner updates. The outermost batch controls settlement. Existing zero-argument callbacks, synchronous return values and `cause` options remain supported. `scope.batch` applies the same rules and its normal ownership checks.

Commands that may be called inside another batch should themselves use `batch(read => ...)`; nesting lets the same command work alone or as part of a larger action. Do not use a closed-over published `runtime.read` value for a batch read-modify-write.

Collection reads return immutable version snapshots, not the internal mutable Map. Repeated reads of the same accepted version reuse the view. A returned snapshot outlives the callback and stays unchanged after later edits; its owning input/Runtime lifecycle still applies. The reader itself does not outlive the callback. Payloads remain readonly by ownership contract; compute a new value instead of mutating a read result.

Borrowed reads and writes are rejected during processing, notification, error reporting, input draft callbacks and input equality. Read across inputs in the outer command, then pass those values into a draft. Borrowed drafts expire when their edit callback ends. Batch and edit callbacks must be synchronous; assigning a Promise as a scalar payload is distinct from returning a Promise from a command. Reading an unmaterialized input only initializes that source. A newly materialized derive in the batch still sees published dependencies.

Input acceptance validates equality before installing any state. It first compares a candidate with the latest accepted value, retaining that reference when equal; otherwise it compares with the published baseline when different and reuses that published reference if equal. This applies to scalar values and collection entries, including removed/re-added keys. All comparisons for one edit complete before installation. Equality must be pure, synchronous and a stable equivalence relation. Publication uses the already normalized references without invoking input equality again.

A failed edit leaves its latest accepted baseline unchanged and throws synchronously; it does not fault the input or roll back earlier successful edits. An outer command exception still settles previous successes, preserving the original exception if error reporting also fails. A batch is not a cross-input or cross-document transaction. A→B→an equivalent A retains the original published reference and produces no value notification; collection order changes still publish. Downstream processor/listener errors after acceptance do not undo source writes. Unrelated subscriptions need not be notified.

## Collection change protocol

Advanced keyed processors receive one transport shape:

```ts
type CollectionChange<K, V> =
  | { kind: 'reset' }
  | {
      kind: 'incremental';
      added: readonly { key: K; after: V }[];
      updated: readonly { key: K; before: V; after: V }[];
      removed: readonly { key: K; before: V }[];
      order?: { before: readonly K[]; after: readonly K[] };
    };
```

Interpret facts separately:

- `reset`: rebuild semantic baseline from current dependency value;
- `added` / `removed`: membership lifecycle changes;
- `updated`: same key/membership, new value;
- `order`: common-member relative order changed.

Do not treat order as “all entries updated”. Do not infer reset from a large incremental change.

`collectionChange.keys(change)` from `doxum/advanced` iterates added→updated→removed entry-transition keys only. It deliberately does not interpret reset or order.

## When to use `doxum/advanced`

Use advanced only when a public pure primitive cannot express the requirement without manual retained state or direct incremental patching.

Good reasons:

- retained state across evaluations;
- independent retained state per driver key;
- a specialized incremental algorithm that updates only affected output keys;
- several output leaves that share retained state/work;
- cross-key coordination that is not a pure keyed selector/reverse index.

Bad reasons:

- mapping one keyed source;
- filtering/compacting/subsetting;
- active keyed lookup;
- reverse group index;
- stable item readables;
- scalar aggregation without retained state.

Those already have first-class public primitives.

## `incremental.keyed`

```ts
const totals = incremental.keyed(
  sections,
  {
    records: { source: records, keys: section => section.recordIds },
  },
  {
    state: (_section, _sectionId) => ({ runs: 0 }),
    process: ({ dependencies, state }) => {
      state.runs++;
      return [...dependencies.records.values()].reduce((sum, record) => sum + record.score, 0);
    },
  }
);
```

The driver owns output membership/order. Each current driver key owns independent optional state.

Lifecycle:

- driver add creates a new state lifecycle and runs that key;
- driver value update reruns that key;
- driver removal releases the key state and dependency bindings;
- driver order-only change updates output order without running `process`;
- dynamic source update reruns only driver keys whose current binding includes the changed source key;
- source order-only change does not invalidate keyed bindings;
- driver reset preserves retained state for keys that remain members;
- processor fault recovery recreates all per-key retained state before reset evaluation.

`process` returns only its own output key value and does not expose collection draft methods.

## `incremental.collection`

Use when one processor owns a keyed output and must apply direct incremental patches:

```ts
const weights = incremental.collection(
  { tasks },
  {
    state: () => ({ ready: false }),
    process: ({ values, changes, output, reset, state }) => {
      if (reset) {
        for (const [id, task] of values.tasks) output.set(id, task.weight);
        output.order([...values.tasks.keys()]);
        state.ready = true;
        return;
      }

      const change = changes.tasks;
      if (!change || change.kind === 'reset') return;
      for (const entry of change.added) output.set(entry.key, entry.after.weight);
      for (const entry of change.updated) output.set(entry.key, entry.after.weight);
      for (const entry of change.removed) output.remove(entry.key);
      if (change.order) output.order([...values.tasks.keys()]);
    },
  }
);
```

Context includes `values`, `changes`, `previous`, `next`, borrowed `output`, `reset`, `cause`, and optional `state`.

Declare `state()` only when retained state is actually needed.

## `incremental.group`

Use one group when several projection leaves share retained state or incremental work:

```ts
const result = incremental.group(
  { scene },
  {
    output: define => ({
      cards: define.collection<CardId, Card>(),
      count: define.value<number>(),
    }),
    state: () => ({ runs: 0 }),
    process: ({ values, output, state }) => {
      state.runs++;
      const cards = buildCards(values.scene);
      for (const [id, card] of cards) output.cards.set(id, card);
      output.cards.order([...cards.keys()]);
      output.count.set(cards.size);
    },
  }
);
```

`define.collection` and `define.value` exist only inside the synchronous static output declaration. Every declared descriptor must be returned exactly once from the output tree. The returned tree has ordinary `Projection` / `KeyedProjection` leaves.

Initial build/recovery must establish each scalar value output. During ordinary incremental runs, untouched scalar leaves retain their published value.

## Processor state and recovery

For advanced processors, `state()` creates retained Runtime-owned state. Source reset does not automatically discard declared retained state. A processor fault is different: Runtime recovery recreates declared retained state and performs a reset evaluation.

Stateless processors use the same recovery lifecycle without a state object.

Do not build application recovery tokens or hidden rebuild channels around processors.

## Error and notification ordering

Materialized processors settle before external projection listeners. Projection writes are not allowed while the graph is processing/notifying.

A projection source/processor/listener failure is reported as `ProjectionError` through Runtime error handling and may block dependents until recovery. It does not roll back an already accepted document commit.

Dispose subscriptions and Runtime/scope ownership with the lifecycle that created them.
