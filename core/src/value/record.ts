export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Installs an own data member without invoking inherited setters such as __proto__. */
export const installOwn = (
  parent: object,
  key: PropertyKey,
  present: boolean,
  value: unknown
): void => {
  if (!present) {
    Reflect.deleteProperty(parent, key);
    return;
  }
  if (Object.hasOwn(parent, key)) {
    Reflect.set(parent, key, value);
    return;
  }
  Object.defineProperty(parent, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
};
