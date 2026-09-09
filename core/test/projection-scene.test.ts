import { describe, expect, it, vi } from 'vitest';
import {
  createDocument,
  createProjectionStore,
  field,
  input,
  object,
  project,
  table,
  type AdvancedCollectionSpec,
} from '../src';
import { projectionStoreDebug } from '../src/integration';
import { startProfile } from '../src/profile';
describe('explicit projection workloads', () => {
  it('routes only adjacent edges after geometry changes and reconnects without automatic dependencies', () => {
    const model = object({
      nodes: table(object({ x: field<number>(), label: field<string>() })),
      edges: table(object({ from: field<string>(), to: field<string>() })),
    });
    const runtime = createDocument({
      schema: model,
      initial: {
        nodes: {
          ids: ['a', 'b', 'c'],
          byId: { a: { x: 1, label: 'A' }, b: { x: 2, label: 'B' }, c: { x: 3, label: 'C' } },
        },
        edges: {
          ids: ['ab', 'bc'],
          byId: { ab: { from: 'a', to: 'b' }, bc: { from: 'b', to: 'c' } },
        },
      },
    });
    const store = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const nodes = project(
      runtime,
      path => path.nodes,
      (_id, node) => node.x
    );
    const edges = project(runtime, path => path.edges);
    const calculated: string[] = [];
    const routes = project({
      kind: 'collection',
      sources: { nodes, edges },
      isEqual: (a: string, b) => a === b,
      build: ({ sources, writer }) => {
        const adjacency = new Map<string, Set<string>>();
        const endpoints = new Map<string, readonly string[]>();
        for (const id of sources.edges.read.ids()) {
          const edge = sources.edges.read.get(id)!;
          const pair = [edge.from, edge.to];
          endpoints.set(id, pair);
          pair.forEach(node => {
            const set = adjacency.get(node) ?? new Set();
            set.add(id);
            adjacency.set(node, set);
          });
          writer.set(id, `${sources.nodes.get(pair[0])}:${sources.nodes.get(pair[1])}`);
        }
        return {
          update: ({ sources, writer }) => {
            const candidates = new Set<string>();
            for (const commit of sources.edges.commits) {
              const change = commit.impact.collection(path => path.edges);
              if (change.kind === 'reset') return { kind: 'rebuild' };
              [...change.added, ...change.updated, ...change.removed].forEach(id => {
                candidates.add(id);
                endpoints.get(id)?.forEach(node => adjacency.get(node)?.delete(id));
                const edge = sources.edges.read.get(id);
                if (!edge) {
                  endpoints.delete(id);
                  return;
                }
                const pair = [edge.from, edge.to];
                endpoints.set(id, pair);
                pair.forEach(node => {
                  const set = adjacency.get(node) ?? new Set();
                  set.add(id);
                  adjacency.set(node, set);
                });
              });
            }
            const change = sources.nodes.change;
            if (change?.kind === 'reset') return { kind: 'rebuild' };
            if (change)
              for (const node of [...change.updated, ...change.added, ...change.removed])
                adjacency.get(node)?.forEach(id => candidates.add(id));
            candidates.forEach(id => {
              calculated.push(id);
              const pair = endpoints.get(id);
              if (!pair) writer.remove(id);
              else writer.set(id, `${sources.nodes.get(pair[0])}:${sources.nodes.get(pair[1])}`);
            });
          },
        };
      },
    } satisfies AdvancedCollectionSpec<
      { nodes: typeof nodes; edges: typeof edges },
      string,
      string
    >);
    const render = project(routes, (_id, route) => `path:${route}`);
    store.get(render);
    runtime.update(tx => (tx.nodes.get('a')!.label = 'content only'));
    expect(calculated).toEqual([]);
    runtime.update(tx => (tx.nodes.get('a')!.x = 10));
    expect(calculated.splice(0)).toEqual(['ab']);
    expect(store.get(routes).get('ab')).toBe('10:2');
    expect(store.get(render).get('ab')).toBe('path:10:2');
    runtime.update(tx => (tx.edges.get('ab')!.from = 'c'));
    expect(calculated.splice(0)).toEqual(['ab']);
    expect(store.get(routes).get('ab')).toBe('3:2');
    runtime.update(tx => (tx.nodes.get('a')!.x = 20));
    expect(calculated).toEqual([]);
    runtime.update(tx => (tx.nodes.get('c')!.x = 30));
    expect(new Set(calculated.splice(0))).toEqual(new Set(['bc', 'ab']));
    runtime.update(tx => tx.edges.remove('ab'));
    expect(store.get(routes).get('ab')).toBeUndefined();
    expect(store.get(render).get('ab')).toBeUndefined();
    store.dispose();
    runtime.dispose();
  });
  it('keeps hover updates local using previous and current input values', () => {
    const store = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const hover = input<string | undefined>(undefined);
    const candidates: string[] = [];
    const view = project({
      kind: 'collection',
      sources: { hover },
      isEqual: (a: boolean, b) => a === b,
      build: () => ({
        update: ({ sources, writer }) => {
          for (const id of new Set([sources.hover.previous, sources.hover.value]))
            if (id) {
              candidates.push(id);
              writer.set(id, id === sources.hover.value);
            }
        },
      }),
    } satisfies AdvancedCollectionSpec<{ hover: typeof hover }, string, boolean>);
    store.get(view);
    store.set(hover, 'a');
    candidates.length = 0;
    store.set(hover, 'b');
    expect(candidates).toEqual(['a', 'b']);
    expect(store.get(view).get('a')).toBe(false);
    expect(store.get(view).get('b')).toBe(true);
    store.dispose();
  });
  it('does not run unrelated nodes and removes disposed nodes from dispatch', () => {
    const store = createProjectionStore({
      onError: error => {
        throw error;
      },
    });
    const source = input(0);
    const other = input(0);
    const update = vi.fn(() => ({ kind: 'unchanged' as const }));
    for (let i = 0; i < 10000; i++)
      store.release(
        project({ kind: 'value', sources: { input: source }, build: () => ({ value: 0, update }) })
      );
    for (let i = 0; i < 100; i++)
      store.get(
        project({ kind: 'value', sources: { input: other }, build: () => ({ value: 0, update }) })
      );
    const active = project({
      kind: 'value',
      sources: { input: source },
      build: ({ input }) => ({
        value: input.value,
        update: ({ input }) => ({ kind: 'changed', value: input.value }),
      }),
    });
    const profile = startProfile();
    store.get(active);
    store.set(source, 1);
    const counters = profile.stop();
    expect(store.get(active)).toBe(1);
    expect(update).not.toHaveBeenCalled();
    expect(counters.materialized.updated).toBe(2);
    expect(projectionStoreDebug(store).nodes).toBe(103);
    store.dispose();
  });
});
