import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const guardFile = 'scripts/check-projection-surface.mjs';
const roots = [
  'core/src',
  'react/src',
  'core/test',
  'react/test',
  'core/bench',
  'docs',
  'skills',
  'README.md',
];
const extensions = new Set(['.ts', '.tsx', '.md', '.mjs']);

const forbiddenText = [
  'DocumentReadable',
  'asReadable',
  'DocumentSelectorOptions',
  'LocalSyncUnavailableError',
  'LocalSyncSchemaError',
  'LocalSyncConsistencyError',
  'LocalSyncReadOnlyError',
  'LocalSyncUnsupportedOperationError',
  'LocalSyncDisposedError',
  'LocalSyncDataError',
  'ProjectionDefinition',
  'ProjectionWithChange',
  'projectionChanges',
  'CollectionDelta',
  'PublicCollection',
  'CollectionProjection',
  'IncrementalState',
  'CollectionHandle',
  'observeExternal',
  'observeExternalCollection',
  'trackProjection',
  'subscribeProjection',
  'CollectionDraft.replace',
  'SchemaHandle',
  'ObjectSchemaHandle',
];

const forbiddenCalls = [
  /\bruntime\.get\s*\(/,
  /\bruntime\.readable\s*\(/,
  /\bruntime\.set\s*\(/,
  /\bscope\.get\s*\(/,
  /\bscope\.readable\s*\(/,
  /\bscope\.set\s*\(/,
  /\bscope\.input(?:\.collection)?\s*\(/,
  /\bscope\.derive(?:\.keyed)?\s*\(/,
  /\bscope\.incremental(?:\.collection|\.group)?\s*\(/,
  /\b(?:runtime|scope)\.batch\s*\(\s*\{/,
  /\bderive\s*\(\s*\[/,
  /\bincremental(?:\.collection|\.group)?\s*\(\s*\[/,
  /\bincremental\.group\s*\([\s\S]{0,600}?\boutputs\s*:/,
];

const filesUnder = entry => {
  const absolute = join(root, entry);
  if (!statSync(absolute).isDirectory()) return [absolute];
  const files = [];
  const visit = current => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (extensions.has(extname(path))) files.push(path);
    }
  };
  visit(absolute);
  return files;
};

const failures = [];
for (const file of roots.flatMap(filesUnder)) {
  const relativePath = relative(root, file);
  if (relativePath === guardFile) continue;
  const text = readFileSync(file, 'utf8');
  const activeText = text.replace(/^\s*\/\/ @ts-expect-error[^\n]*\n[^\n]*/gm, '');
  for (const symbol of forbiddenText) {
    if (activeText.includes(symbol)) failures.push(`${relativePath}: stale ${symbol}`);
  }
  for (const pattern of forbiddenCalls) {
    if (pattern.test(activeText)) failures.push(`${relativePath}: stale call ${pattern}`);
  }
}

const rootIndex = readFileSync(join(root, 'core/src/index.ts'), 'utf8');
const concreteSchemaTypes = [
  'FieldNode',
  'OptionalNode',
  'ObjectShape',
  'ObjectNode',
  'VariantShape',
  'VariantNode',
  'TableNode',
  'MapNode',
  'ListNode',
  'TreeNode',
  'DocumentNode',
];
for (const symbol of concreteSchemaTypes) {
  if (new RegExp(`\\b${symbol}\\b`).test(rootIndex))
    failures.push(`core/src/index.ts: concrete schema type exposed: ${symbol}`);
}
if (/\bKeyedDependency\b/.test(rootIndex))
  failures.push('core/src/index.ts: dynamic keyed dependency helper type exposed');
if (/\bCollectionChange\b/.test(rootIndex))
  failures.push('core/src/index.ts: processor-facing CollectionChange exposed');

const projectionRuntime = readFileSync(join(root, 'core/src/projection/runtime.ts'), 'utf8');
if (/from ['"]\.\/advanced['"]/.test(projectionRuntime))
  failures.push(
    'core/src/projection/runtime.ts: root runtime imports advanced projection factories'
  );

const projectionContract = readFileSync(join(root, 'core/src/projection/contract.ts'), 'utf8');
if (/readonly\s+(?:identity|revisions)\b/.test(projectionContract))
  failures.push('core/src/projection/contract.ts: ProjectionError exposes scheduler diagnostics');

const advanced = readFileSync(join(root, 'core/src/projection/advanced.ts'), 'utf8');
if (/\bRebuild\b/.test(advanced))
  failures.push('core/src/projection/advanced.ts: public rebuild protocol reintroduced');

const reactIndex = readFileSync(join(root, 'react/src/index.ts'), 'utf8');
if (/\bProjectionContext\b/.test(reactIndex))
  failures.push('react/src/index.ts: ProjectionContext exposed');

if (failures.length) {
  console.error('Public surface guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Public surface guard passed.');
}
