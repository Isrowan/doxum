export type CloneReason =
  'initial' | 'canonical' | 'commit' | 'inverse' | 'reader' | 'replace' | 'journal' | 'snapshot';

type CloneCounters = {
  calls: number;
  containers: number;
  nodes: Record<CloneReason, number>;
  deepEqual: { calls: number; containers: number };
  documents: { initial: number };
};
type ProfileCounters = {
  clone: CloneCounters;
  mutation: { normalized: number; executed: number; inverseCreated: number };
  batch: {
    operations: number;
    entries: number;
    collectionsResolved: number;
    journalRecords: number;
    rejected: number;
    inverseOperations: number;
    payloadTransferred: number;
    payloadSnapshots: number;
  };
  journal: {
    subjects: number;
    comparisons: number;
    absorbed: number;
    orderSnapshots: number;
    orderItems: number;
  };
  address: {
    schemaSteps: number;
    documentSteps: number;
    prefixComparisons: number;
    segmentsCompared: number;
    arraysCopied: number;
  };
  impact: { affectsChecks: number };
  reader: {
    sessions: number;
    nodeLookups: number;
    collectionIds: number;
    structuralSnapshots: number;
  };
  collectionView: {
    mappedItems: number;
    idsScanned: number;
    arraysCopied: number;
  };
  materialized: {
    updated: number;
    skipped: number;
    rebuilt: number;
    sourceChanges: number;
    notifications: number;
  };
};

export type ProfileSnapshot = Readonly<{
  clone: Readonly<{
    calls: number;
    containers: number;
    nodes: Readonly<Record<CloneReason, number>>;
    deepEqual: Readonly<{ calls: number; containers: number }>;
    documents: Readonly<{ initial: number }>;
  }>;
  mutation: Readonly<{
    normalized: number;
    executed: number;
    inverseCreated: number;
  }>;
  batch: Readonly<ProfileCounters['batch']>;
  journal: Readonly<ProfileCounters['journal']>;
  address: Readonly<ProfileCounters['address']>;
  impact: Readonly<ProfileCounters['impact']>;
  reader: Readonly<ProfileCounters['reader']>;
  collectionView: Readonly<ProfileCounters['collectionView']>;
  materialized: Readonly<ProfileCounters['materialized']>;
}>;

const cloneReasons = (): Record<CloneReason, number> => ({
  initial: 0,
  canonical: 0,
  commit: 0,
  inverse: 0,
  reader: 0,
  replace: 0,
  journal: 0,
  snapshot: 0,
});

const counters = (): ProfileCounters => ({
  clone: {
    calls: 0,
    containers: 0,
    nodes: cloneReasons(),
    deepEqual: { calls: 0, containers: 0 },
    documents: { initial: 0 },
  },
  mutation: { normalized: 0, executed: 0, inverseCreated: 0 },
  batch: {
    operations: 0,
    entries: 0,
    collectionsResolved: 0,
    journalRecords: 0,
    rejected: 0,
    inverseOperations: 0,
    payloadTransferred: 0,
    payloadSnapshots: 0,
  },
  journal: {
    subjects: 0,
    comparisons: 0,
    absorbed: 0,
    orderSnapshots: 0,
    orderItems: 0,
  },
  address: {
    schemaSteps: 0,
    documentSteps: 0,
    prefixComparisons: 0,
    segmentsCompared: 0,
    arraysCopied: 0,
  },
  impact: { affectsChecks: 0 },
  reader: {
    sessions: 0,
    nodeLookups: 0,
    collectionIds: 0,
    structuralSnapshots: 0,
  },
  collectionView: { mappedItems: 0, idsScanned: 0, arraysCopied: 0 },
  materialized: {
    updated: 0,
    skipped: 0,
    rebuilt: 0,
    sourceChanges: 0,
    notifications: 0,
  },
});

// Recorder calls are stable no-op-capable functions. Only this module owns the
// mutable session counter tree; domain code never branches on profile state.
const active = { current: undefined as ProfileCounters | undefined };

// Snapshot allocation is intentionally delayed until the caller asks for it.
const freezeSnapshot = (value: ProfileCounters): ProfileSnapshot =>
  Object.freeze({
    clone: Object.freeze({
      calls: value.clone.calls,
      containers: value.clone.containers,
      nodes: Object.freeze({ ...value.clone.nodes }),
      deepEqual: Object.freeze({ ...value.clone.deepEqual }),
      documents: Object.freeze({ ...value.clone.documents }),
    }),
    mutation: Object.freeze({ ...value.mutation }),
    batch: Object.freeze({ ...value.batch }),
    journal: Object.freeze({ ...value.journal }),
    address: Object.freeze({ ...value.address }),
    impact: Object.freeze({ ...value.impact }),
    reader: Object.freeze({ ...value.reader }),
    collectionView: Object.freeze({ ...value.collectionView }),
    materialized: Object.freeze({ ...value.materialized }),
  });

export const profile = {
  clone: {
    call: (): void => {
      const value = active.current;
      if (value) value.clone.calls += 1;
    },
    node: (reason: CloneReason): void => {
      const value = active.current;
      if (!value) return;
      value.clone.nodes[reason] += 1;
    },
    container: (): void => {
      const value = active.current;
      if (value) value.clone.containers += 1;
    },
    deepEqual: (): void => {
      const value = active.current;
      if (value) value.clone.deepEqual.calls += 1;
    },
    deepEqualContainer: (): void => {
      const value = active.current;
      if (value) value.clone.deepEqual.containers += 1;
    },
    initialDocument: (): void => {
      const value = active.current;
      if (value) value.clone.documents.initial += 1;
    },
  },
  mutation: {
    normalized: (): void => {
      const value = active.current;
      if (value) value.mutation.normalized += 1;
    },
    executed: (): void => {
      const value = active.current;
      if (value) value.mutation.executed += 1;
    },
    inverse: (): void => {
      const value = active.current;
      if (value) value.mutation.inverseCreated += 1;
    },
  },
  batch: {
    operation: (): void => {
      const value = active.current;
      if (value) value.batch.operations += 1;
    },
    entry: (amount = 1): void => {
      const value = active.current;
      if (value) value.batch.entries += amount;
    },
    collectionResolved: (): void => {
      const value = active.current;
      if (value) value.batch.collectionsResolved += 1;
    },
    journalRecord: (): void => {
      const value = active.current;
      if (value) value.batch.journalRecords += 1;
    },
    rejected: (): void => {
      const value = active.current;
      if (value) value.batch.rejected += 1;
    },
    inverse: (): void => {
      const value = active.current;
      if (value) value.batch.inverseOperations += 1;
    },
    payloadTransferred: (): void => {
      const value = active.current;
      if (value) value.batch.payloadTransferred += 1;
    },
    payloadSnapshot: (): void => {
      const value = active.current;
      if (value) value.batch.payloadSnapshots += 1;
    },
  },
  journal: {
    subject: (): void => {
      const value = active.current;
      if (value) value.journal.subjects += 1;
    },
    comparison: (): void => {
      const value = active.current;
      if (value) value.journal.comparisons += 1;
    },
    absorbed: (): void => {
      const value = active.current;
      if (value) value.journal.absorbed += 1;
    },
    orderSnapshot: (items: number): void => {
      const value = active.current;
      if (!value) return;
      value.journal.orderSnapshots += 1;
      value.journal.orderItems += items;
    },
  },
  address: {
    schemaStep: (): void => {
      const value = active.current;
      if (value) value.address.schemaSteps += 1;
    },
    documentStep: (): void => {
      const value = active.current;
      if (value) value.address.documentSteps += 1;
    },
    arrayCopied: (): void => {
      const value = active.current;
      if (value) value.address.arraysCopied += 1;
    },
    prefixComparison: (): void => {
      const value = active.current;
      if (value) value.address.prefixComparisons += 1;
    },
    segmentCompared: (): void => {
      const value = active.current;
      if (value) value.address.segmentsCompared += 1;
    },
  },
  impact: {
    affects: (): void => {
      const value = active.current;
      if (value) value.impact.affectsChecks += 1;
    },
  },
  reader: {
    session: (): void => {
      const value = active.current;
      if (value) value.reader.sessions += 1;
    },
    lookup: (): void => {
      const value = active.current;
      if (value) value.reader.nodeLookups += 1;
    },
    collectionIds: (amount = 1): void => {
      const value = active.current;
      if (value) value.reader.collectionIds += amount;
    },
    structuralSnapshot: (): void => {
      const value = active.current;
      if (value) value.reader.structuralSnapshots += 1;
    },
  },
  collectionView: {
    mapped: (): void => {
      const value = active.current;
      if (value) value.collectionView.mappedItems += 1;
    },
    idsScanned: (amount = 1): void => {
      const value = active.current;
      if (value) value.collectionView.idsScanned += amount;
    },
    arrayCopied: (): void => {
      const value = active.current;
      if (value) value.collectionView.arraysCopied += 1;
    },
  },
  materialized: {
    updated: (): void => {
      const value = active.current;
      if (value) value.materialized.updated += 1;
    },
    skipped: (): void => {
      const value = active.current;
      if (value) value.materialized.skipped += 1;
    },
    rebuilt: (): void => {
      const value = active.current;
      if (value) value.materialized.rebuilt += 1;
    },
    sourceChanged: (): void => {
      const value = active.current;
      if (value) value.materialized.sourceChanges += 1;
    },
    notification: (): void => {
      const value = active.current;
      if (value) value.materialized.notifications += 1;
    },
  },
} as const;

export type ProfileSession = {
  readonly snapshot: () => ProfileSnapshot;
  readonly stop: () => ProfileSnapshot;
};

export const startProfile = (): ProfileSession => {
  if (active.current) throw new Error('A document profile session is already active.');
  const value = counters();
  active.current = value;
  let stopped = false;
  const snapshot = (): ProfileSnapshot => freezeSnapshot(value);
  return {
    snapshot,
    stop: (): ProfileSnapshot => {
      if (!stopped) {
        stopped = true;
        active.current = undefined;
      }
      return snapshot();
    },
  };
};

export const measureProfile = <T>(
  run: () => T
): { readonly value: T; readonly profile: ProfileSnapshot } => {
  const session = startProfile();
  try {
    const value = run();
    return { value, profile: session.stop() };
  } catch (error) {
    session.stop();
    throw error;
  }
};
