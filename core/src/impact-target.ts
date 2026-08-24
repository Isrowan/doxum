import type { DocumentAddress, DocumentSchema, ImpactTarget } from './schema';

export const address = (target: ImpactTarget<unknown>): DocumentAddress =>
  'at' in target ? target.at : target.address;

export const id = (target: ImpactTarget<unknown>): string | undefined =>
  target.kind === 'collection' && 'id' in target ? target.id : undefined;

export const belongs = (target: ImpactTarget<unknown>, schema: DocumentSchema): boolean =>
  !('schema' in target) || target.schema === schema;

export const same = (left: ImpactTarget<unknown>, right: ImpactTarget<unknown>): boolean => {
  if (left.kind !== right.kind) return false;
  if ('schema' in left && 'schema' in right && left.schema !== right.schema) return false;
  const leftAddress = address(left);
  const rightAddress = address(right);
  if (leftAddress.length !== rightAddress.length) return false;
  for (let index = 0; index < leftAddress.length; index += 1)
    if (leftAddress[index] !== rightAddress[index]) return false;
  return left.kind !== 'collection' || id(left) === id(right);
};

export const bucket = (target: ImpactTarget<unknown>): string | undefined => address(target)[0];
