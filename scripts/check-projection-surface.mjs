import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
const forbidden = [
  'ProjectionDefinition',
  'SourceBoundary',
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
];
const roots = ['core/src', 'react/src', 'core/test', 'react/test', 'docs', 'skills', 'README.md'];
const extensions = new Set(['.ts', '.tsx', '.md']);

const filesUnder = directory => {
  const absolute = join(root, directory);
  if (!statSync(absolute).isDirectory()) return [absolute];
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (extensions.has(path.slice(path.lastIndexOf('.')))) files.push(path);
    }
  };
  visit(absolute);
  return files;
};

const failures = [];
for (const file of roots.flatMap(filesUnder)) {
  const relativePath = relative(root, file);
  const text = readFileSync(file, 'utf8');
  for (const symbol of forbidden) {
    if (text.includes(symbol)) failures.push(`${relativePath}: ${symbol}`);
  }
}

const publicEntrypoints = [
  ['core/src/index.ts', ['ProjectionDefinition', 'PublicCollection', 'CollectionProjection']],
  [
    'core/src/projection/advanced.ts',
    ['ProjectionDefinition', 'PublicCollection', 'CollectionProjection'],
  ],
  ['react/src/index.ts', ['ProjectionContext']],
];
for (const [file, symbols] of publicEntrypoints) {
  const text = readFileSync(join(root, file), 'utf8');
  for (const symbol of symbols) {
    if (new RegExp(`export[^\\n]*\\b${symbol}\\b`).test(text))
      failures.push(`${file}: exported ${symbol}`);
  }
}

if (failures.length) {
  console.error('Projection surface guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else console.log('Projection surface guard passed.');
