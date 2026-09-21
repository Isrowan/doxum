import { describe, expect, it, vi } from 'vitest';
import { AddressIndex } from '@/address/index';
import { compareExtended } from '@/address/relation';

describe('address algorithms', () => {
  it('compares an appended address segment without materializing the address', () => {
    expect(compareExtended(['boards'], 'a', ['boards'])).toBe('descendant');
    expect(compareExtended(['boards'], 'a', ['boards', 'a'])).toBe('equal');
    expect(compareExtended(['boards'], 'a', ['boards', 'a', 'title'])).toBe('ancestor');
    expect(compareExtended(['boards'], 'a', ['boards', 'b'])).toBe('disjoint');
  });

  it('indexes appended segments directly and traverses one overlap without batch state', () => {
    const index = new AddressIndex<string>();
    index.add(['boards'], 'board-a', 'a');
    index.add(['boards', 'a', 'title'], 'title');
    index.add(['settings'], 'settings');

    expect(index.overlaps(['boards'], 'a')).toBe(true);
    expect(index.hasDescendant(['boards'], 'a')).toBe(true);
    expect(index.overlaps(['boards'], 'b')).toBe(false);

    const visit = vi.fn();
    index.forEachOverlap(['boards', 'a'], visit);
    expect(visit.mock.calls.map(([value]) => value)).toEqual(['board-a', 'title']);

    index.delete(['boards'], 'board-a', 'a');
    expect(index.exact(['boards', 'a'])?.size ?? 0).toBe(0);
    expect(index.hasDescendant(['boards'], 'a')).toBe(true);
    index.delete(['boards', 'a', 'title'], 'title');
    expect(index.overlaps(['boards'], 'a')).toBe(false);
  });
});
