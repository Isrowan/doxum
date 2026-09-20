import { createRequire } from 'node:module';

const expected = new Map([
  ['doxum', ['createDocument', 'createProjectionRuntime', 'derive', 'input', 'observe']],
  ['doxum/advanced', ['incremental']],
  ['doxum/local-sync', ['LocalSyncError', 'attachLocalSync']],
  ['doxum/react', ['ProjectionProvider', 'useHistory', 'useInput', 'useProjection']],
]);

const require = createRequire(import.meta.url);
const failures = [];
for (const [specifier, names] of expected) {
  const esm = await import(specifier);
  const cjs = require(specifier);
  for (const name of names) {
    if (!(name in esm)) failures.push(`${specifier}: ESM export ${name} is missing`);
    if (!(name in cjs)) failures.push(`${specifier}: CJS export ${name} is missing`);
  }
}

if (failures.length) {
  console.error('Built package export smoke failed:');
  failures.forEach(failure => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log('Built package export smoke passed.');
}
