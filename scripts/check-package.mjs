import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = [
  'LICENSE',
  'README.md',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/local-sync.cjs',
  'dist/local-sync.d.ts',
  'dist/local-sync.js',
  'dist/react.cjs',
  'dist/react.d.ts',
  'dist/react.js',
  'dist/advanced.cjs',
  'dist/advanced.d.ts',
  'dist/advanced.js',
  'skills/doxum-runtime/SKILL.md',
  'skills/doxum-runtime/agents/openai.yaml',
  'skills/doxum-runtime/references/public-api.md',
  'skills/doxum-runtime/references/document-runtime.md',
  'skills/doxum-runtime/references/projections.md',
  'skills/doxum-runtime/references/integrations.md',
  'skills/doxum-runtime/references/recipes.md',
  'skills/doxum-runtime/references/invariants.md',
];

const [tarball] = JSON.parse(
  execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
);
if (!tarball || !Array.isArray(tarball.files))
  throw new Error('Could not inspect the doxum tarball.');
const files = new Set(tarball.files.map(file => file.path));
for (const file of requiredFiles)
  if (!files.has(file)) throw new Error(`Package is missing '${file}'.`);
for (const { path } of tarball.files) {
  if (
    !['package.json', 'README.md', 'LICENSE'].includes(path) &&
    !path.startsWith('skills/') &&
    !/^dist\/.*\.(?:js|cjs|d\.ts|d\.cts)$/.test(path)
  )
    throw new Error(`Unexpected published file '${path}'.`);
  if (
    path.startsWith('dist/') &&
    /\.c?js$/.test(path) &&
    /[#@] sourceMappingURL=/.test(readFileSync(resolve(root, path), 'utf8'))
  )
    throw new Error(
      `Published JavaScript references a source map: '${path}'. Use build:debug for maps.`
    );
}
console.log(
  `Package contract passed: ${tarball.files.length} files, ${(tarball.unpackedSize / 1000).toFixed(1)} kB unpacked, ${(tarball.size / 1000).toFixed(1)} kB packed.`
);
