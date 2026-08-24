import type { Unsubscribe } from '../runtime/contract';

export type Readable<TValue> = {
  current(): TValue;
  revision(): number;
  subscribe(listener: () => void): Unsubscribe;
};
