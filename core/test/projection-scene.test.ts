import { describe, expect, it, vi } from 'vitest';
import { createDocument, createProjectionRuntime, field, object, schema, table } from '../src';
import { projectionDebug } from '../src/integration';
import { startProfile } from '../src/profile';

describe('explicit projection workloads', () => {
  it('routes only adjacent edges after geometry changes and reconnects without automatic dependencies', () => {
    const model = schema({
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
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const document = projection.document(runtime);
    const nodes = projection.map(
      document.collection(path => path.nodes),
      (_id, node) => node.x.get()
    );
    const edges = document.collection(path => path.edges);
    const calculated: string[] = [];
    const routes = projection.collection<string>()({
      sources: { nodes, edges },
      isEqual: (a: string, b) => a === b,
      build: ({ sources, writer }) => {
        const adjacency = new Map<string, Set<string>>();
        const endpoints = new Map<string, readonly string[]>();
        for (const id of sources.edges.read.ids()) {
          const edge = sources.edges.read.get(id)!;
          const pair = [edge.from.get(), edge.to.get()];
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
              const change = commit.impact.collection(sources.edges.target);
              if (change.kind === 'reset') return { kind: 'rebuild' };
              [...change.added, ...change.updated, ...change.removed].forEach(id => {
                candidates.add(id);
                endpoints.get(id)?.forEach(node => adjacency.get(node)?.delete(id));
                const edge = sources.edges.read.get(id);
                if (!edge) {
                  endpoints.delete(id);
                  return;
                }
                const pair = [edge.from.get(), edge.to.get()];
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
    });
    const render = projection.map(routes, (_id, route) => `path:${route}`);
    runtime.update(tx => tx.write.nodes.item('a').label.set('content only'));
    expect(calculated).toEqual([]);
    runtime.update(tx => tx.write.nodes.item('a').x.set(10));
    expect(calculated.splice(0)).toEqual(['ab']);
    expect(routes.item('ab').current()).toBe('10:2');
    expect(render.item('ab').current()).toBe('path:10:2');
    runtime.update(tx => tx.write.edges.item('ab').from.set('c'));
    expect(calculated.splice(0)).toEqual(['ab']);
    expect(routes.item('ab').current()).toBe('3:2');
    runtime.update(tx => tx.write.nodes.item('a').x.set(20));
    expect(calculated).toEqual([]);
    runtime.update(tx => tx.write.nodes.item('c').x.set(30));
    expect(new Set(calculated.splice(0))).toEqual(new Set(['bc', 'ab']));
    runtime.update(tx => tx.write.edges.remove('ab'));
    expect(routes.item('ab').current()).toBeUndefined();
    expect(render.item('ab').current()).toBeUndefined();
    projection.dispose();
    runtime.dispose();
  });

  it('keeps hover updates local using previous and current input values', () => {
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const hover = projection.input<string | undefined>(undefined);
    const candidates: string[] = [];
    const view = projection.collection<boolean>()({
      sources: { hover: hover.source },
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
    });
    hover.set('a');
    candidates.length = 0;
    hover.set('b');
    expect(candidates).toEqual(['a', 'b']);
    expect(view.item('a').current()).toBe(false);
    expect(view.item('b').current()).toBe(true);
    projection.dispose();
  });

  it('does not run unrelated nodes and removes disposed nodes from dispatch', () => {
    const projection = createProjectionRuntime({
      onError: error => {
        throw error;
      },
    });
    const source = projection.input(0);
    const other = projection.input(0);
    const update = vi.fn(() => ({ kind: 'unchanged' as const }));
    for (let i = 0; i < 10_000; i++)
      projection
        .value({ sources: { input: source.source }, build: () => ({ value: 0, update }) })
        .dispose();
    for (let i = 0; i < 100; i++)
      projection.value({ sources: { input: other.source }, build: () => ({ value: 0, update }) });
    const active = projection.value({
      sources: { input: source.source },
      build: ({ input }) => ({
        value: input.value,
        update: ({ input }) => ({ kind: 'changed', value: input.value }),
      }),
    });
    const profile = startProfile();
    source.set(1);
    const counters = profile.stop();
    expect(active.current()).toBe(1);
    expect(update).not.toHaveBeenCalled();
    expect(counters.materialized.updated).toBe(1);
    expect(projectionDebug(projection).nodes).toBe(101);
    projection.dispose();
  });
});
