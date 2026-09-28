/** Ends one registration at most once; safe after owner disposal. */
export type Unsubscribe = () => void;

export type Readable<TValue> = {
  current(): TValue;
  revision(): number;
  /** Each call registers independently, even when the listener function is reused. */
  subscribe(listener: () => void): Unsubscribe;
};
