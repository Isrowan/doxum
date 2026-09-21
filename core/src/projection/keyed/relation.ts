export type KeyRelation = {
  replace(left: string, right: readonly string[]): boolean;
  delete(left: string): boolean;
  forward(left: string): readonly string[] | undefined;
  reverse(right: string): ReadonlySet<string> | undefined;
  lefts(): IterableIterator<string>;
  rights(): IterableIterator<string>;
  clear(): void;
};

/** Runtime-local domain-neutral many-to-many keyed relation. */
export const createKeyRelation = (): KeyRelation => {
  const forward = new Map<string, readonly string[]>();
  const reverse = new Map<string, Set<string>>();

  const detach = (left: string, right: readonly string[]): void => {
    for (const key of right) {
      const dependents = reverse.get(key);
      dependents?.delete(left);
      if (dependents?.size === 0) reverse.delete(key);
    }
  };

  const attach = (left: string, right: readonly string[]): void => {
    for (const key of right) {
      const dependents = reverse.get(key);
      if (dependents) dependents.add(left);
      else reverse.set(key, new Set([left]));
    }
  };

  return {
    replace(left, right) {
      const previous = forward.get(left) ?? Object.freeze([]);
      if (previous.length === right.length && previous.every((key, index) => key === right[index]))
        return false;
      detach(left, previous);
      if (!right.length) {
        forward.delete(left);
        return true;
      }
      const next = Object.freeze([...right]);
      forward.set(left, next);
      attach(left, next);
      return true;
    },
    delete(left) {
      const previous = forward.get(left);
      if (!previous) return false;
      detach(left, previous);
      forward.delete(left);
      return true;
    },
    forward: left => forward.get(left),
    reverse: right => reverse.get(right),
    lefts: () => forward.keys(),
    rights: () => reverse.keys(),
    clear() {
      forward.clear();
      reverse.clear();
    },
  };
};
