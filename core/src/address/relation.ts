import { profile } from '@/profile';
import type { DocumentAddress } from '@/schema/model';

export type AddressRelation = 'ancestor' | 'equal' | 'descendant' | 'disjoint';

export const contains = (parent: DocumentAddress, child: DocumentAddress): boolean => {
  profile.address.prefixComparison();
  if (parent.length > child.length) return false;
  for (let index = 0; index < parent.length; index += 1) {
    profile.address.segmentCompared();
    if (parent[index] !== child[index]) return false;
  }
  return true;
};

/** Compare a virtual `[...base, segment]` address with an existing address without allocating it. */
export const compareExtended = (
  base: DocumentAddress,
  segment: string,
  other: DocumentAddress
): AddressRelation => {
  profile.address.prefixComparison();
  const length = base.length + 1;
  const common = Math.min(length, other.length);
  for (let index = 0; index < common; index += 1) {
    profile.address.segmentCompared();
    const value = index < base.length ? base[index] : segment;
    if (value !== other[index]) return 'disjoint';
  }
  return length === other.length ? 'equal' : length < other.length ? 'ancestor' : 'descendant';
};
