import type { ProjectionInputs, ProjectionSources } from './contract';
import { ProjectionDisposedError } from './contract';
import type { NodeRecord, Scheduler } from './scheduler';

export const createNode = <S extends ProjectionSources>(
  scheduler: Scheduler,
  spec: { name?: string; sources: S },
  behavior: {
    evaluate(sources: ProjectionInputs<S>, build: boolean, active: () => boolean): boolean;
    context(active: () => boolean): unknown;
    revision(): number;
    reset(): boolean;
    publish(): void;
    emit(call: (listener: () => void) => void): void;
    clear(): void;
    release(): void;
  }
) => {
  scheduler.assertIdle();
  const entries = Object.entries(spec.sources).map(
    ([key, handle]) => [key, scheduler.source(handle)] as const
  );
  const order = scheduler.order();
  const node: NodeRecord = {
    ...behavior,
    publish: () => {
      if (node.fault) behavior.clear();
      else behavior.publish();
    },
    order,
    name: spec.name ? `${spec.name} (${order})` : `projection-${order}`,
    sources: entries.map(([, source]) => source),
    consumers: new Set(),
    disposed: false,
    fault: undefined,
    forced: false,
    statusChanged: false,
    evaluate: build => {
      let active = true;
      try {
        const scopeActive = () => active;
        // Heterogeneous source contexts are typed at the registered capability boundary.
        const inputs = Object.fromEntries(
          entries.map(([key, source]) => [key, source.context(scopeActive)])
        ) as ProjectionInputs<S>;
        return behavior.evaluate(inputs, build, scopeActive);
      } finally {
        active = false;
      }
    },
  };
  scheduler.initialize(() => {
    const invalid = node.sources.find(source => source.fault || source.disposed);
    if (invalid) throw invalid.fault ?? new ProjectionDisposedError();
    node.evaluate(true);
    node.publish();
    node.clear();
  });
  const check = () => {
    if (node.disposed || !scheduler.active) throw new ProjectionDisposedError();
    if (node.fault) throw node.fault;
  };
  return {
    node,
    check,
    install(handle: object) {
      scheduler.register(handle, node);
      scheduler.addNode(node);
    },
    rebuild: () => scheduler.rebuild(node),
    dispose: () => scheduler.disposeNode(node),
  };
};
