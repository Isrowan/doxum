import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const sourceRoots = ['core/src', 'react/src'];
const extensions = new Set(['.ts', '.tsx']);
const tsconfigPath = join(root, 'tsconfig.base.json');
const loadedTsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
if (loadedTsconfig.error)
  throw new Error(ts.flattenDiagnosticMessageText(loadedTsconfig.error.messageText, '\n'));
const tsconfig = loadedTsconfig.config;
const internalAliasTargets = tsconfig.compilerOptions?.paths?.['@/*'];
if (!Array.isArray(internalAliasTargets) || internalAliasTargets.length !== 1)
  throw new Error('tsconfig.base.json must define exactly one @/* target.');
const internalAliasPattern = internalAliasTargets[0];
if (typeof internalAliasPattern !== 'string' || !internalAliasPattern.endsWith('/*'))
  throw new Error('tsconfig.base.json @/* target must end with /*.');
const tsconfigBase = tsconfig.compilerOptions?.baseUrl
  ? resolve(dirname(tsconfigPath), tsconfig.compilerOptions.baseUrl)
  : dirname(tsconfigPath);
const internalAliasRoot = resolve(tsconfigBase, internalAliasPattern.slice(0, -2));

const walk = entry => {
  const absolute = join(root, entry);
  const files = [];
  const visit = current => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stats = statSync(path);
      if (stats.isDirectory()) visit(path);
      else if (extensions.has(extname(path))) files.push(normalize(path));
    }
  };
  visit(absolute);
  return files;
};

const files = sourceRoots.flatMap(walk);
const fileSet = new Set(files);

const isRuntimeImport = statement => {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    if (clause.name) return true;
    const bindings = clause.namedBindings;
    if (!bindings) return false;
    if (ts.isNamespaceImport(bindings)) return true;
    return bindings.elements.some(element => !element.isTypeOnly);
  }
  if (ts.isExportDeclaration(statement)) {
    if (!statement.moduleSpecifier || statement.isTypeOnly) return false;
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) return true;
    return clause.elements.some(element => !element.isTypeOnly);
  }
  return false;
};

const moduleSpecifier = statement => {
  if (!('moduleSpecifier' in statement) || !statement.moduleSpecifier) return undefined;
  return ts.isStringLiteralLike(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : undefined;
};

const resolveInternal = (from, specifier) => {
  const base = specifier.startsWith('@/')
    ? resolve(internalAliasRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  return candidates.map(normalize).find(candidate => fileSet.has(candidate));
};

const graph = new Map(files.map(file => [file, []]));
const failures = [];
const rel = file => relative(root, file).replaceAll('\\', '/');

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  for (const statement of source.statements) {
    const specifier = moduleSpecifier(statement);
    if (!specifier) continue;
    const dependency = resolveInternal(file, specifier);
    const sourcePath = rel(file);
    const targetPath = dependency ? rel(dependency) : undefined;

    if (sourcePath.startsWith('core/src/')) {
      if (specifier === 'doxum' || specifier.startsWith('doxum/'))
        failures.push(`${sourcePath}: core internals must not import package entry ${specifier}`);
      if (targetPath?.startsWith('core/src/')) {
        const sameDirectory = dirname(file) === dirname(dependency);
        if (sameDirectory && !specifier.startsWith('./'))
          failures.push(`${sourcePath}: same-directory import must stay relative: ${specifier}`);
        if (!sameDirectory && !specifier.startsWith('@/'))
          failures.push(`${sourcePath}: cross-directory import must use @/: ${specifier}`);
      }
    }
    if (sourcePath.startsWith('react/src/') && specifier.startsWith('@/'))
      failures.push(`${sourcePath}: react must consume core through doxum public exports`);

    if (!isRuntimeImport(statement)) continue;
    if (dependency && graph.has(dependency)) graph.get(file).push(dependency);
  }
}

const edgesFrom = file => graph.get(file) ?? [];
for (const file of files) {
  const source = rel(file);
  for (const dependency of edgesFrom(file)) {
    const target = rel(dependency);
    if (source.startsWith('core/') && target.startsWith('react/'))
      failures.push(`${source}: core must not runtime-import ${target}`);
    if (target === 'core/src/index.ts' || target === 'react/src/index.ts')
      failures.push(`${source}: internal module runtime-imports package barrel ${target}`);
    if (
      (source === 'core/src/schema/model.ts' || source === 'core/src/schema/layout.ts') &&
      (target.includes('/runtime') || target.includes('/projection/'))
    )
      failures.push(`${source}: schema foundation runtime-imports ${target}`);
    if (
      (source === 'core/src/runtime.ts' ||
        source.startsWith('core/src/runtime/') ||
        source.startsWith('core/src/mutation/')) &&
      target.startsWith('core/src/projection/')
    )
      failures.push(`${source}: document/mutation core runtime-imports ${target}`);
    if (
      source === 'core/src/projection/definition.ts' &&
      (target.includes('/projection/graph/') ||
        target.includes('/projection/source/') ||
        target === 'core/src/runtime/context.ts')
    )
      failures.push(`${source}: lazy projection definition runtime-imports ${target}`);
  }
}

let nextIndex = 0;
const stack = [];
const index = new Map();
const low = new Map();
const onStack = new Set();

const visit = file => {
  index.set(file, nextIndex);
  low.set(file, nextIndex);
  nextIndex++;
  stack.push(file);
  onStack.add(file);
  for (const dependency of edgesFrom(file)) {
    if (!index.has(dependency)) {
      visit(dependency);
      low.set(file, Math.min(low.get(file), low.get(dependency)));
    } else if (onStack.has(dependency)) {
      low.set(file, Math.min(low.get(file), index.get(dependency)));
    }
  }
  if (low.get(file) !== index.get(file)) return;
  const component = [];
  while (stack.length) {
    const current = stack.pop();
    onStack.delete(current);
    component.push(current);
    if (current === file) break;
  }
  const selfCycle = component.length === 1 && edgesFrom(component[0]).includes(component[0]);
  if (component.length > 1 || selfCycle)
    failures.push(`runtime import cycle: ${component.map(rel).sort().join(' -> ')}`);
};

for (const file of files) if (!index.has(file)) visit(file);

if (failures.length) {
  console.error('Runtime import graph guard failed:');
  for (const failure of [...new Set(failures)].sort()) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Runtime import graph guard passed (${files.length} source files).`);
}
