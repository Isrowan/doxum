import { snapshotArray } from '@/value/array';
import { profile } from '@/profile';

export type KeyRelation = {
  replaceOne(left: string, right: string | undefined): boolean;
  replace(left: string, right: readonly string[]): boolean;
  delete(left: string): boolean;
  forward(left: string): readonly string[] | undefined;
  reverse(right: string): ReadonlySet<string> | undefined;
  lefts(): IterableIterator<string>;
  rights(): IterableIterator<string>;
  clear(): void;
};

/** Runtime-local many-to-many relation. Callers validate unique string keys before replacing.
 * Forward order is meaningful; reverse sets and map iteration carry no formal order.
 */
export const createKeyRelation = (): KeyRelation => {
  const forward = new Map<string, readonly string[]>();
  const reverse = new Map<string, Set<string>>();

  const detach = (left: string, right: string): void => {
    const dependents = reverse.get(right);
    if (!dependents?.delete(left)) return;
    profile.keyRelation('detachedEdges');
    if (dependents.size === 0) {
      reverse.delete(right);
      profile.keyRelation('deletedBuckets');
    }
  };

  const attach = (left: string, right: string): boolean => {
    const dependents = reverse.get(right);
    if (dependents) {
      if (dependents.has(left)) return false;
      dependents.add(left);
    } else {
      reverse.set(right, new Set([left]));
      profile.keyRelation('createdBuckets');
    }
    profile.keyRelation('attachedEdges');
    return true;
  };

  return {
    replaceOne(left, right) {
      const previous = forward.get(left);
      if (right === undefined) {
        if (!previous) return false;
        for (const key of previous) detach(left, key);
        forward.delete(left);
        return true;
      }
      if (previous?.length === 1 && previous[0] === right) return false;
      const next = Object.freeze([right]);
      if (previous) for (const key of previous) if (key !== right) detach(left, key);
      attach(left, right);
      forward.set(left, next);
      return true;
    },
    replace(left, right) {
      const previous = forward.get(left);
      if (!previous) {
        if (!right.length) return false;
        const next = snapshotArray(right);
        for (const key of next) attach(left, key);
        forward.set(left, next);
        return true;
      }
      if (previous === right) return false;
      if (!right.length) {
        for (const key of previous) detach(left, key);
        forward.delete(left);
        return true;
      }

      let start = 0;
      while (start < previous.length && start < right.length && previous[start] === right[start])
        start++;
      if (start === previous.length && start === right.length) return false;
      // Snapshot before touching the relation; only the unmatched middle needs a membership index.
      const next = snapshotArray(right);
      let oldEnd = previous.length;
      let nextEnd = next.length;
      while (oldEnd > start && nextEnd > start && previous[oldEnd - 1] === next[nextEnd - 1]) {
        oldEnd--;
        nextEnd--;
      }
      // Unique keys in the unchanged ends cannot also occur in either middle.
      // Reverse membership supplies the old-key index while installing only additions.
      let retained = 0;
      for (let index = start; index < nextEnd; index++) if (!attach(left, next[index])) retained++;
      if (retained === 0) {
        for (let index = start; index < oldEnd; index++) detach(left, previous[index]);
      } else if (retained < oldEnd - start) {
        if (nextEnd - start === 1) {
          for (let index = start; index < oldEnd; index++)
            if (previous[index] !== next[start]) detach(left, previous[index]);
        } else {
          const requested = new Set<string>();
          for (let index = start; index < nextEnd; index++) requested.add(next[index]);
          profile.keyRelation('diffSets');
          profile.keyRelation('diffKeys', requested.size);
          for (let index = start; index < oldEnd; index++)
            if (!requested.has(previous[index])) detach(left, previous[index]);
        }
      }
      forward.set(left, next);
      return true;
    },
    delete(left) {
      const previous = forward.get(left);
      if (!previous) return false;
      for (const key of previous) detach(left, key);
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
