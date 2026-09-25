import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const declaration = readFileSync(
  join(
    process.cwd(),
    'node_modules/.cache/doxum-declaration-portability/declaration-portability.d.ts'
  ),
  'utf8'
);

const forbidden = [
  ['hashed contract chunk', /contract-[A-Za-z0-9_-]+/],
  ['hashed projection definition chunk', /definition-[A-Za-z0-9_-]+/],
  ['package-internal dist path', /doxum\/dist\//],
];

const failures = forbidden
  .filter(([, pattern]) => pattern.test(declaration))
  .map(([label]) => `generated consumer declaration references ${label}`);

const required = [
  ['named subset result', 'portableNamedSubset: import("doxum").KeyedProjection<string, number>;'],
  ['named get result', 'portableNamedGet: import("doxum").Projection<number | undefined>;'],
  ['static get result', 'portableStaticGet: import("doxum").Projection<number | undefined>;'],
  [
    'singleton constant tuple inference',
    'portableConstantSingleton: import("doxum").KeyedProjection<"constant", 1>;',
  ],
  [
    'scalar singleton overload',
    'portableScalarSingleton: import("doxum").KeyedProjection<"optional", {',
  ],
  [
    'singleton union inference with typed equality',
    'portableSingletonPreview: import("doxum").KeyedProjection<"preview", PortablePreview>;',
  ],
  ['fromEntries result', 'portableFromEntries: import("doxum").KeyedProjection<string, number>;'],
  [
    'fromEntries union inference with typed equality',
    'portableInferredPreview: import("doxum").KeyedProjection<"preview", PortablePreview>;',
  ],
  ['flatMap result', 'portableFlatMap: import("doxum").KeyedProjection<string, number>;'],
  ['portable schema handle', 'portableSchema: import("doxum").ObjectSchema<'],
  ['keyed derive result', 'portableSelected: import("doxum").KeyedProjection<string, number>;'],
  ['keyed join result', 'portableJoined: import("doxum").KeyedProjection<string, string>;'],
  [
    'plural keyed dependency result',
    'portablePluralJoined: import("doxum").KeyedProjection<string, string | undefined>;',
  ],
  [
    'driver-owned keyed value inference',
    'portableFilteredValue: import("doxum").KeyedProjection<string, number>;',
  ],
  [
    'keyed reverse index result',
    'portableGrouped: import("doxum").KeyedProjection<string, readonly string[]>;',
  ],
  [
    'incremental keyed result',
    'portableIncrementalKeyed: import("doxum").KeyedProjection<string, string>;',
  ],
  [
    'group collection leaf',
    'portableGroupValues: import("doxum").KeyedProjection<string, number>;',
  ],
  ['group value leaf', 'portableGroupCount: import("doxum").Projection<number>;'],
];

for (const [label, expected] of required) {
  if (!declaration.includes(expected))
    failures.push(`generated consumer declaration lost ${label}`);
}

if (failures.length) {
  console.error('Declaration portability check failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Declaration portability check passed.');
}
