const counters = () => ({
  projection: {
    sourceEvents: 0,
    scheduledNodes: 0,
    processedNodes: 0,
    touchedKeys: 0,
    changedKeys: 0,
    publishedNodes: 0,
    flushes: 0,
  },
  copy: { structures: 0 },
  equality: { calls: 0, containers: 0 },
  recorder: {
    facts: 0,
    groups: 0,
    transitions: 0,
    absorbed: 0,
    orderSnapshots: 0,
    orderItems: 0,
    treeNodes: 0,
    sealed: 0,
    indexedGroups: 0,
  },
  access: { scopes: 0, proxies: 0, snapshots: 0, addresses: 0, resolutions: 0 },
  address: {
    schemaSteps: 0,
    documentSteps: 0,
    prefixComparisons: 0,
    segmentsCompared: 0,
    arraysCopied: 0,
    listIndexes: 0,
    listItems: 0,
  },
  impact: { affectsChecks: 0, indexes: 0 },
  collectionView: { mappedItems: 0, idsScanned: 0, arraysCopied: 0 },
  materialized: { updated: 0, rebuilt: 0, notifications: 0 },
});
type Counters = ReturnType<typeof counters>;
type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] };
export type ProfileSnapshot = DeepReadonly<Counters>;
let active: Counters | undefined;
const freeze = <T extends object>(value: T): DeepReadonly<T> => {
  Object.values(value).forEach(child => {
    if (child && typeof child === 'object') freeze(child);
  });
  return Object.freeze(value) as DeepReadonly<T>;
};
export const profile = {
  projection: (key: keyof Counters['projection'], amount = 1) => {
    if (active) active.projection[key] += amount;
  },
  recorder: (key: keyof Counters['recorder'], amount = 1) => {
    if (active) active.recorder[key] += amount;
  },
  access: (key: keyof Counters['access']) => {
    if (active) active.access[key]++;
  },
  copy: {
    structure: () => {
      if (active) active.copy.structures++;
    },
  },
  equality: {
    call: () => {
      if (active) active.equality.calls++;
    },
    container: () => {
      if (active) active.equality.containers++;
    },
  },
  address: {
    listIndex: (items: number) => {
      if (active) {
        active.address.listIndexes++;
        active.address.listItems += items;
      }
    },
    schemaStep: () => {
      if (active) active.address.schemaSteps++;
    },
    documentStep: () => {
      if (active) active.address.documentSteps++;
    },
    arrayCopied: () => {
      if (active) active.address.arraysCopied++;
    },
    prefixComparison: () => {
      if (active) active.address.prefixComparisons++;
    },
    segmentCompared: () => {
      if (active) active.address.segmentsCompared++;
    },
  },
  impact: {
    index: () => {
      if (active) active.impact.indexes++;
    },
    affects: () => {
      if (active) active.impact.affectsChecks++;
    },
  },
  collectionView: {
    mapped: () => {
      if (active) active.collectionView.mappedItems++;
    },
    idsScanned: (amount = 1) => {
      if (active) active.collectionView.idsScanned += amount;
    },
    arrayCopied: () => {
      if (active) active.collectionView.arraysCopied++;
    },
  },
  materialized: {
    updated: () => {
      if (active) active.materialized.updated++;
    },
    rebuilt: () => {
      if (active) active.materialized.rebuilt++;
    },
    notification: () => {
      if (active) active.materialized.notifications++;
    },
  },
};
export type ProfileSession = { snapshot(): ProfileSnapshot; stop(): ProfileSnapshot };
export const startProfile = (): ProfileSession => {
  if (active) throw new Error('A document profile session is already active.');
  const value = counters();
  active = value;
  const snapshot = () => freeze(structuredClone(value));
  return {
    snapshot,
    stop: () => {
      if (active === value) active = undefined;
      return snapshot();
    },
  };
};
export const measureProfile = <T>(run: () => T): { value: T; profile: ProfileSnapshot } => {
  const session = startProfile();
  try {
    return { value: run(), profile: session.stop() };
  } finally {
    session.stop();
  }
};
