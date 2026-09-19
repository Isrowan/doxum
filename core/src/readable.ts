export type Unsubscribe = () => void;

export type Readable<TValue> = {
  current(): TValue;
  revision(): number;
  subscribe(listener: () => void): Unsubscribe;
};
