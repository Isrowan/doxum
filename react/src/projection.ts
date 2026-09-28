import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from 'react';
import type { ProjectionRuntime, ProjectionScope } from 'doxum';

export const ProjectionContext = createContext<ProjectionRuntime | ProjectionScope | undefined>(
  undefined
);

export type ProjectionProviderProps = { readonly children?: ReactNode } & (
  | { readonly runtime: ProjectionRuntime; readonly fallback?: ReactNode; readonly value?: never }
  | {
      readonly value: ProjectionRuntime | ProjectionScope;
      readonly runtime?: never;
      readonly fallback?: never;
    }
);

const ManagedProjectionProvider = ({
  runtime,
  fallback,
  children,
}: {
  readonly runtime: ProjectionRuntime;
  readonly fallback?: ReactNode;
  readonly children?: ReactNode;
}) => {
  const generation = useRef(0);
  const [owner, setOwner] = useState<{
    runtime: ProjectionRuntime;
    scope: ProjectionScope;
    generation: number;
  }>();
  useEffect(() => {
    const scope = runtime.scope();
    setOwner({ runtime, scope, generation: ++generation.current });
    return () => scope.dispose();
  }, [runtime]);
  // No resource is acquired by an abandoned render or by server rendering.
  // A new setup also remounts definitions bound to the previous scope.
  if (!owner || owner.runtime !== runtime) return fallback ?? null;
  return createElement(
    ProjectionContext.Provider,
    { value: owner.scope, key: owner.generation },
    children
  );
};

/** runtime creates an owned scope after commit; value borrows an external owner. */
export const ProjectionProvider = (props: ProjectionProviderProps): ReactElement => {
  if (props.runtime !== undefined) {
    if (props.value !== undefined)
      throw new TypeError('ProjectionProvider accepts runtime or value, not both.');
    return createElement(ManagedProjectionProvider, props);
  }
  if (props.value === undefined)
    throw new TypeError('ProjectionProvider requires runtime or value.');
  return createElement(ProjectionContext.Provider, { value: props.value }, props.children);
};

/** Reads a scope supplied by a managed Provider or an explicitly injected scope. */
export const useProjectionScope = (): ProjectionScope => {
  const owner = useContext(ProjectionContext);
  if (!owner || !('own' in owner)) throw new Error('A ProjectionScope provider is required.');
  return owner;
};
