import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageName = 'doxum';
const releaseFiles = ['package.json', 'pnpm-lock.yaml'];
const requiredFiles = [
  'LICENSE',
  'README.md',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/integration.cjs',
  'dist/integration.d.ts',
  'dist/integration.js',
  'dist/react.cjs',
  'dist/react.d.ts',
  'dist/react.js',
  'skills/doxum-runtime/SKILL.md',
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

const manifestPath = resolve(root, 'package.json');
const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'));
const writeManifest = manifest =>
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const lockstepVersion = manifest => {
  if (typeof manifest.version !== 'string' || !stableVersion.test(manifest.version))
    fail('doxum must start from a stable semver version.');
  return manifest.version;
};

const releaseVersion = manifest => {
  const [major, minor, patch] = lockstepVersion(manifest).split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
};

const assertRepository = ({ resume }) => {
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

const assertManifestContract = manifest => {
  if (manifest.name !== packageName) fail(`package.json must name ${packageName}.`);
  if (manifest.private !== false) fail(`${packageName} must be public.`);
  if (manifest.license !== 'MIT') fail(`${packageName} must declare the MIT license.`);
  if (manifest.publishConfig?.access !== 'public')
    fail(`${packageName} must declare publishConfig.access as public.`);
  if (!manifest.description || !manifest.repository || !manifest.homepage || !manifest.bugs)
    fail(`${packageName} is missing required npm metadata.`);
  if (manifest.peerDependencies?.react !== '>=18')
    fail(`${packageName} must declare React as a peer dependency.`);
  if (manifest.peerDependenciesMeta?.react?.optional !== true)
    fail(`${packageName} must mark its React peer dependency as optional.`);
  if (!manifest.exports?.['./react']) fail(`${packageName} must export ./react.`);
};

const assertTarball = () => {
  const result = output('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
  const [tarball] = JSON.parse(result);
  if (!tarball || !Array.isArray(tarball.files))
    fail(`Could not inspect the ${packageName} tarball.`);
  const files = new Set(tarball.files.map(file => file.path));
  for (const file of requiredFiles)
    if (!files.has(file)) fail(`${packageName} tarball is missing '${file}'.`);
};

const published = version => {
  const result = spawnSync('npm', ['view', `${packageName}@${version}`, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) return true;
  if (String(result.stderr).includes('E404')) return false;
  fail(String(result.stderr).trim() || `Could not check ${packageName}@${version} on npm.`);
};

const publish = version => {
  if (published(version)) return;
  command('pnpm', [
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
      fail('Release commit may only contain package.json and pnpm-lock.yaml.');
    command('git', ['add', '--', ...releaseFiles]);
    command('git', ['commit', '-m', `release: v${version}`]);
  } else {
    const manifest = JSON.parse(output('git', ['show', 'HEAD:package.json']));
    if (manifest.version !== version) fail(`HEAD does not record ${packageName} at ${version}.`);
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
  const manifest = readManifest();
  assertManifestContract(manifest);
  let version;
  let values;
  let publishStarted = false;

  try {
    if (resume) {
      const files = statusFiles();
      if (files.length > 0 && !hasOnlyReleaseFiles(files))
        fail('Release resume only accepts the pending package.json and pnpm-lock.yaml.');
      version = lockstepVersion(manifest);
    } else {
      version = releaseVersion(manifest);
      values = snapshot();
      manifest.version = version;
      writeManifest(manifest);
    }

    command('pnpm', ['install', '--lockfile-only']);
    command('pnpm', ['run', 'check']);
    command('pnpm', ['run', 'build']);
    assertTarball();

    publishStarted = true;
    publish(version);
    finishGitRelease(version);
    process.stdout.write(`Published ${packageName} at v${version}.\n`);
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
