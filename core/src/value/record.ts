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
