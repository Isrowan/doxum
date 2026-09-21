import { describe, expect, it } from 'vitest';
import { moveSelection } from '@/order/anchor';
import type { DocumentAnchor } from '@/schema/model';

const randomSource = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

const referenceMove = (
  current: readonly string[],
  selection: readonly string[],
  position?: DocumentAnchor
) => {
  if (!selection.length) return { kind: 'ok' as const, order: current };
  const selected = new Set<string>();
  for (const key of selection) {
    if (selected.has(key)) return { kind: 'duplicate' as const };
    selected.add(key);
  }
  const remaining = current.filter(key => !selected.has(key));
  const moved = current.filter(key => selected.has(key));
  if (moved.length !== selected.size) return { kind: 'missing' as const };

  let insertion: number;
  if (!position || ('at' in position && position.at === 'end')) insertion = remaining.length;
  else if ('at' in position) insertion = 0;
  else {
    const key = 'before' in position ? position.before : position.after;
    const index = remaining.indexOf(key);
    if (index < 0) return { kind: 'invalid-anchor' as const };
    insertion = 'before' in position ? index : index + 1;
  }
  return {
    kind: 'ok' as const,
    order: [...remaining.slice(0, insertion), ...moved, ...remaining.slice(insertion)],
  };
};

describe('order algorithms', () => {
  it('matches the direct move model across randomized selections and anchors', () => {
    const random = randomSource(0xa11ce55);
    const pool = Array.from({ length: 10 }, (_, index) => `key-${index}`);
    for (let sample = 0; sample < 1_000; sample++) {
      const current = pool.filter(() => random() < 0.75);
      const selection = pool.filter(() => random() < 0.35);
      if (random() < 0.08 && selection.length) selection.push(selection[0]);
      if (random() < 0.08) selection.push('missing');
      const anchor =
        random() < 0.15 || !current.length
          ? 'missing'
          : current[Math.floor(random() * current.length)];
      const choice = Math.floor(random() * 5);
      const position: DocumentAnchor | undefined =
        choice === 0
          ? undefined
          : choice === 1
            ? { at: 'start' }
            : choice === 2
              ? { at: 'end' }
              : choice === 3
                ? { before: anchor }
                : { after: anchor };
      expect(moveSelection(current, selection, position)).toEqual(
        referenceMove(current, selection, position)
      );
    }
  });
});
