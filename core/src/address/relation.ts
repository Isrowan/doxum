import { profile } from '../profile';
import type { DocumentAddress } from '../schema';
import type { AddressRef } from './resolve';

export const contains = (parent: DocumentAddress, child: DocumentAddress): boolean => {
  profile.address.prefixComparison();
  if (parent.length > child.length) return false;
  for (let index = 0; index < parent.length; index += 1) {
    profile.address.segmentCompared();
    if (parent[index] !== child[index]) return false;
  }
  return true;
};

export const overlaps = (left: DocumentAddress, right: DocumentAddress): boolean =>
  contains(left, right) || contains(right, left);

export const debugKey = (address: DocumentAddress): string => {
  let result = '';
  for (let index = 0; index < address.length; index++) {
    if (index > 0) result += '/';
    result += address[index].replaceAll('~', '~~').replaceAll('/', '~/');
  }
  return result;
};

export const same = (left: AddressRef, right: AddressRef): boolean => {
  if (left.path !== right.path || left.address.length !== right.address.length) return false;
  for (let index = 0; index < left.address.length; index += 1) {
    profile.address.segmentCompared();
    if (left.address[index] !== right.address[index]) return false;
  }
  return true;
};
