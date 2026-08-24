import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = [
  {
    name: '@doxa/core',
    directory: 'core',
    requiredFiles: ['LICENSE', 'README.md', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.js'],
  },
  {
    name: '@doxa/react',
    directory: 'react',
    requiredFiles: ['LICENSE', 'README.md', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.js'],
  },
];
const releaseFiles = [
  ...packages.map(entry => `${entry.directory}/package.json`),
  'pnpm-lock.yaml',
];
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const fail = message => {
  throw new Error(message);
};

const command = (executable, args, options = {}) => {
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) fail(`Could not run '${executable}': ${result.error.message}`);
  if (result.status !== 0) fail(`'${[executable, ...args].join(' ')}' failed.`);
};

const output = (executable, args, options = {}) => {
  try {
    return execFileSync(executable, args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? '').trim();
    fail(detail || `Could not run '${[executable, ...args].join(' ')}'.`);
  }
};

const statusFiles = () => {
  const value = output('git', ['status', '--porcelain']);
  if (!value) return [];
  return value.split('\n').map(line => line.slice(3));
};

const hasOnlyReleaseFiles = files =>
  files.length > 0 && files.every(file => releaseFiles.includes(file));

const manifestPath = entry => resolve(root, entry.directory, 'package.json');
const readManifest = entry => JSON.parse(readFileSync(manifestPath(entry), 'utf8'));
const writeManifest = (entry, manifest) =>
  writeFileSync(manifestPath(entry), `${JSON.stringify(manifest, null, 2)}\n`);

const lockstepVersion = manifests => {
  const versions = manifests.map(entry => entry.manifest.version);
  if (!versions.every(version => typeof version === 'string' && stableVersion.test(version)))
    fail('Published packages must start from the same stable semver version.');
  if (!versions.every(version => version === versions[0]))
    fail(`Published packages must use one lockstep version; found ${versions.join(', ')}.`);
  return versions[0];
};

const releaseVersion = manifests => {
  const [major, minor, patch] = lockstepVersion(manifests).split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

const assertRepository = ({ resume }) => {
  const rootManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (rootManifest.private !== true) fail('The workspace root must remain private.');
  const branch = output('git', ['branch', '--show-current']);
  if (branch !== 'main')
    fail(`Releases must run from main; current branch is '${branch || 'detached'}'.`);
  if (!resume) {
    if (statusFiles().length) fail('Release requires a clean working tree.');
    command('git', ['fetch', '--quiet', 'origin', 'main', '--tags']);
    const [behind, ahead] = output('git', ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
      .split(/\s+/)
      .map(Number);
    if (behind !== 0 || ahead !== 0)
      fail('Release requires main to be synchronized with its upstream.');
  }
  if (!output('git', ['config', 'user.name']) || !output('git', ['config', 'user.email']))
    fail('Git user.name and user.email must be configured before release.');
  command('npm', ['whoami']);
};

const assertManifestContract = manifests => {
  for (const { entry, manifest } of manifests) {
    if (manifest.name !== entry.name)
      fail(`${entry.directory}/package.json must name ${entry.name}.`);
    if (manifest.private !== false) fail(`${entry.name} must be public.`);
    if (manifest.license !== 'MIT') fail(`${entry.name} must declare the MIT license.`);
    if (manifest.publishConfig?.access !== 'public')
      fail(`${entry.name} must declare publishConfig.access as public.`);
    if (!manifest.description || !manifest.repository || !manifest.homepage || !manifest.bugs)
      fail(`${entry.name} is missing required npm metadata.`);
  }
  const react = manifests.find(({ entry }) => entry.name === '@doxa/react')?.manifest;
  if (react?.dependencies?.['@doxa/core'] !== 'workspace:*')
    fail('@doxa/react must depend on @doxa/core through workspace:*.');
};

const packedFiles = entry => {
  const result = output('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: resolve(root, entry.directory),
  });
  const [tarball] = JSON.parse(result);
  if (!tarball || !Array.isArray(tarball.files))
    fail(`Could not inspect the ${entry.name} tarball.`);
  return new Set(tarball.files.map(file => file.path));
};

const assertTarballs = () => {
  for (const entry of packages) {
    const files = packedFiles(entry);
    for (const file of entry.requiredFiles)
      if (!files.has(file)) fail(`${entry.name} tarball is missing '${file}'.`);
  }
};

const published = (name, version) => {
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return true;
  if (String(result.stderr).includes('E404')) return false;
  fail(String(result.stderr).trim() || `Could not check ${name}@${version} on npm.`);
};

const publish = (entry, version) => {
  if (published(entry.name, version)) return;
  command('pnpm', [
    '--filter',
    entry.name,
    'publish',
    '--access',
    'public',
    '--tag',
    'latest',
    '--publish-branch',
    'main',
    '--no-git-checks',
  ]);
};

const tagFor = version => `v${version}`;
const tagPointsAtHead = tag => {
  try {
    return output('git', ['rev-parse', `${tag}^{commit}`]) === output('git', ['rev-parse', 'HEAD']);
  } catch {
    return false;
  }
};

const finishGitRelease = version => {
  const files = statusFiles();
  if (files.length > 0) {
    if (!hasOnlyReleaseFiles(files))
      fail('Release commit may only contain package manifests and pnpm-lock.yaml.');
    command('git', ['add', '--', ...releaseFiles]);
    command('git', ['commit', '-m', `release: v${version}`]);
  } else {
    for (const entry of packages) {
      const manifest = JSON.parse(output('git', ['show', `HEAD:${entry.directory}/package.json`]));
      if (manifest.version !== version)
        fail(`HEAD does not record ${entry.name} at the published version ${version}.`);
    }
  }
  const tag = tagFor(version);
  if (!tagPointsAtHead(tag)) {
    const existing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
      cwd: root,
      stdio: 'ignore',
    });
    if (existing.status === 0) fail(`Tag '${tag}' already exists and does not point at HEAD.`);
    command('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
  }
  command('git', ['push', 'origin', 'main', '--follow-tags']);
};

const snapshot = () =>
  new Map(releaseFiles.map(file => [file, readFileSync(resolve(root, file), 'utf8')]));
const restore = values => {
  for (const [file, value] of values) writeFileSync(resolve(root, file), value);
};

const run = () => {
  const args = process.argv.slice(2);
  const resume = args.length === 1 && args[0] === '--resume';
  if (args.length > 0 && !resume)
    fail('Release accepts no arguments. Use pnpm release:resume only after a publish failure.');

  assertRepository({ resume });
  const manifests = packages.map(entry => ({ entry, manifest: readManifest(entry) }));
  assertManifestContract(manifests);
  let version;
  let values;
  let publishStarted = false;

  try {
    if (resume) {
      const files = statusFiles();
      if (files.length > 0 && !hasOnlyReleaseFiles(files))
        fail('Release resume only accepts the pending package manifests and pnpm-lock.yaml.');
      version = lockstepVersion(manifests);
    } else {
      version = releaseVersion(manifests);
      values = snapshot();
      for (const { entry, manifest } of manifests) {
        manifest.version = version;
        writeManifest(entry, manifest);
      }
    }

    command('pnpm', ['install', '--lockfile-only']);
    command('pnpm', ['run', 'check']);
    command('pnpm', ['run', 'build']);
    assertTarballs();

    publishStarted = true;
    for (const entry of packages) publish(entry, version);
    finishGitRelease(version);
    process.stdout.write(`Published @doxa/core and @doxa/react at v${version}.\n`);
  } catch (error) {
    if (!publishStarted && values) restore(values);
    if (publishStarted)
      process.stderr.write(
        'Release state was preserved. Fix the problem, then run pnpm release:resume.\n'
      );
    throw error;
  }
};

try {
  run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
