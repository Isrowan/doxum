import React, { StrictMode, Suspense, useEffect, useMemo, useState } from 'react';
import { act, create } from 'react-test-renderer';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createProjectionRuntime,
  derive,
  input,
  ProjectionDisposedError,
  type ProjectionRuntime,
  type ProjectionScope,
} from 'doxum';
import { ProjectionProvider, useInput, useProjection, useProjectionScope } from 'doxum/react';

const trackedRuntime = () => {
  const runtime = createProjectionRuntime();
  const scopes: ProjectionScope[] = [];
  const stops = vi.fn();
  const scope = vi.fn(() => {
    const next = runtime.scope();
    next.onDispose(stops);
    scopes.push(next);
    return next;
  });
  return {
    runtime,
    owner: { ...runtime, scope } satisfies ProjectionRuntime,
    scope,
    scopes,
    stops,
  };
};

describe('React projection scope ownership', () => {
  it('creates fresh committed scopes through StrictMode replay and keeps scoped definitions usable', () => {
    const tracking = trackedRuntime();
    let current!: ProjectionScope;
    let update!: (value: number) => void;
    let effectSetups = 0;
    const Probe = () => {
      current = useProjectionScope();
      const count = useMemo(() => current.own(input(1)), [current]);
      const doubled = useMemo(
        () => current.own(derive({ count }, ({ count }) => count * 2)),
        [count, current]
      );
      const [value, set] = useInput(count);
      update = set;
      useEffect(() => {
        effectSetups++;
        const stop = current.select(count).subscribe(() => undefined);
        return () => {
          stop();
          stop();
        };
      }, [count]);
      return (
        <span>
          {value}:{useProjection(doubled)}
        </span>
      );
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <StrictMode>
          <ProjectionProvider runtime={tracking.owner}>
            <Probe />
          </ProjectionProvider>
        </StrictMode>
      );
    });
    expect(tracking.scope.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(tracking.stops).toHaveBeenCalledTimes(tracking.scopes.length - 1);
    expect(effectSetups).toBeGreaterThanOrEqual(2);
    expect(renderer.toJSON()).toMatchObject({ children: ['1', ':', '2'] });
    act(() => update(3));
    expect(renderer.toJSON()).toMatchObject({ children: ['3', ':', '6'] });
    const active = current;
    act(() => renderer.unmount());
    expect(tracking.stops).toHaveBeenCalledTimes(tracking.scopes.length);
    expect(() => active.read(input(0))).toThrow(ProjectionDisposedError);
    expect(tracking.runtime.read(input(7))).toBe(7);
    tracking.runtime.dispose();
    expect(tracking.stops).toHaveBeenCalledTimes(tracking.scopes.length);
  });

  it('replaces runtime and scope generations together, remounting local definitions and state', () => {
    const first = trackedRuntime();
    const second = trackedRuntime();
    const seen: ProjectionScope[] = [];
    let update!: (value: number) => void;
    let setLocal!: (value: number) => void;
    const Probe = () => {
      const scope = useProjectionScope();
      seen.push(scope);
      const count = useMemo(() => scope.own(input(1)), [scope]);
      const [value, set] = useInput(count);
      const [local, setState] = useState(0);
      update = set;
      setLocal = setState;
      return (
        <span>
          {value}:{local}
        </span>
      );
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ProjectionProvider runtime={first.owner}>
          <Probe />
        </ProjectionProvider>
      );
    });
    act(() => {
      update(4);
      setLocal(5);
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['4', ':', '5'] });
    const old = seen.at(-1)!;
    act(() =>
      renderer.update(
        <ProjectionProvider runtime={second.owner}>
          <Probe />
        </ProjectionProvider>
      )
    );
    expect(renderer.toJSON()).toMatchObject({ children: ['1', ':', '0'] });
    expect(seen.at(-1)).not.toBe(old);
    expect(() => old.read(input(1))).toThrow(ProjectionDisposedError);
    expect(first.runtime.read(input(2))).toBe(2);
    act(() => renderer.unmount());
    first.runtime.dispose();
    second.runtime.dispose();
  });

  it('safely runs React cleanup after the parent runtime has already disposed every scope', () => {
    const tracking = trackedRuntime();
    const count = input(1);
    const events: number[] = [];
    const Probe = () => {
      const scope = useProjectionScope();
      useEffect(() => scope.onDispose(() => events.push(scope.read(count))), [scope]);
      return <span>{useProjection(count)}</span>;
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <ProjectionProvider runtime={tracking.owner}>
          <Probe />
        </ProjectionProvider>
      );
    });
    tracking.runtime.dispose();
    expect(events).toEqual([1]);
    expect(() => act(() => renderer.unmount())).not.toThrow();
    expect(tracking.stops).toHaveBeenCalledTimes(1);
  });

  it('borrows injected owners without disposing them and exposes explicitly injected scopes', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const stopped = vi.fn();
    scope.onDispose(stopped);
    const count = scope.own(input(2));
    const Probe = () => {
      expect(useProjectionScope()).toBe(scope);
      return <span>{useProjection(count)}</span>;
    };
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        <StrictMode>
          <ProjectionProvider value={scope}>
            <Probe />
          </ProjectionProvider>
        </StrictMode>
      );
    });
    act(() => renderer.unmount());
    expect(stopped).not.toHaveBeenCalled();
    expect(scope.read(count)).toBe(2);
    runtime.dispose();
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('renders only the managed fallback on the server without acquiring resources', () => {
    const tracking = trackedRuntime();
    const Probe = vi.fn(() => <span>ready</span>);
    expect(
      renderToString(
        <ProjectionProvider runtime={tracking.owner} fallback={<span>loading</span>}>
          <Probe />
        </ProjectionProvider>
      )
    ).toBe('<span>loading</span>');
    expect(tracking.scope).not.toHaveBeenCalled();
    expect(Probe).not.toHaveBeenCalled();
    expect(
      renderToString(
        <ProjectionProvider runtime={tracking.owner}>
          <Probe />
        </ProjectionProvider>
      )
    ).toBe('');
    tracking.runtime.dispose();
  });

  it('supports synchronous server rendering with an externally owned scope', () => {
    const runtime = createProjectionRuntime();
    const scope = runtime.scope();
    const count = scope.own(input(2));
    const Probe = () => <span>{useProjection(count)}</span>;
    expect(
      renderToString(
        <ProjectionProvider value={scope}>
          <Probe />
        </ProjectionProvider>
      )
    ).toBe('<span>2</span>');
    expect(scope.read(count)).toBe(2);
    runtime.dispose();
  });

  it('does not acquire a scope in an abandoned suspended render', async () => {
    const tracking = trackedRuntime();
    const pending = new Promise<void>(() => undefined);
    const Suspend = (): React.ReactNode => {
      throw pending;
    };
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(
        <Suspense fallback={<span>suspended</span>}>
          <ProjectionProvider runtime={tracking.owner}>
            <span>unused</span>
          </ProjectionProvider>
          <Suspend />
        </Suspense>
      );
    });
    expect(renderer.toJSON()).toMatchObject({ children: ['suspended'] });
    expect(tracking.scope).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
    tracking.runtime.dispose();
    expect(tracking.stops).not.toHaveBeenCalled();
  });

  it('requires a scope for useProjectionScope and never implicitly creates one from a borrowed runtime', () => {
    const tracking = trackedRuntime();
    const Probe = () => {
      useProjectionScope();
      return null;
    };
    expect(() => renderToString(<Probe />)).toThrow('ProjectionScope');
    expect(() =>
      renderToString(
        <ProjectionProvider value={tracking.owner}>
          <Probe />
        </ProjectionProvider>
      )
    ).toThrow('ProjectionScope');
    expect(tracking.scope).not.toHaveBeenCalled();
    tracking.runtime.dispose();
  });
});
