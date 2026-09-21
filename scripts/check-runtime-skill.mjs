import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillRoot = resolve(root, 'skills/doxum-runtime');
const publicReference = resolve(skillRoot, 'references/public-api.md');

const fail = message => {
  throw new Error(`Doxum runtime skill check failed: ${message}`);
};

const exportedBindings = declaration => {
  const names = [];
  const visit = name => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
      for (const element of name.elements) if (ts.isBindingElement(element)) visit(element.name);
  };
  visit(declaration.name);
  return names;
};

const hasExportModifier = node =>
  Boolean(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));

const collectExports = relativePath => {
  const file = resolve(root, relativePath);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const names = new Set();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause || !ts.isNamedExports(statement.exportClause))
        fail(
          `${relativePath} contains export *; enumerate the public surface for skill validation.`
        );
      for (const element of statement.exportClause.elements) names.add(element.name.text);
      continue;
    }
    if (!hasExportModifier(statement)) continue;
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) names.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations)
        for (const name of exportedBindings(declaration)) names.add(name);
  }
  return names;
};

const collectObjectAssignMembers = (relativePath, bindingName) => {
  const file = resolve(root, relativePath);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== bindingName) continue;
      const initializer = declaration.initializer;
      if (
        !initializer ||
        !ts.isCallExpression(initializer) ||
        !ts.isPropertyAccessExpression(initializer.expression) ||
        !ts.isIdentifier(initializer.expression.expression) ||
        initializer.expression.expression.text !== 'Object' ||
        initializer.expression.name.text !== 'assign'
      )
        fail(`${relativePath} ${bindingName} must be assembled with Object.assign.`);
      const members = initializer.arguments[1];
      if (!members || !ts.isObjectLiteralExpression(members))
        fail(`${relativePath} ${bindingName} must declare its family members inline.`);
      const names = new Set();
      for (const property of members.properties) {
        if (ts.isSpreadAssignment(property))
          fail(`${relativePath} ${bindingName} family must not use spread members.`);
        if (
          !ts.isPropertyAssignment(property) &&
          !ts.isShorthandPropertyAssignment(property) &&
          !ts.isMethodDeclaration(property)
        )
          fail(`${relativePath} ${bindingName} contains an unsupported family member.`);
        const name = property.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
          names.add(name.text);
        else fail(`${relativePath} ${bindingName} family members must use static names.`);
      }
      return names;
    }
  }
  fail(`${relativePath} is missing ${bindingName}.`);
};

const reference = readFileSync(publicReference, 'utf8');
const documentedExports = packageName => {
  const start = `<!-- exports:${packageName}:start -->`;
  const end = `<!-- exports:${packageName}:end -->`;
  const from = reference.indexOf(start);
  const to = reference.indexOf(end);
  if (from < 0 || to < from) fail(`missing export inventory markers for ${packageName}.`);
  const block = reference.slice(from + start.length, to);
  const names = new Set();
  for (const match of block.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) names.add(match[1]);
  return names;
};

const documentedFamily = familyName => {
  const start = `<!-- family:${familyName}:start -->`;
  const end = `<!-- family:${familyName}:end -->`;
  const from = reference.indexOf(start);
  const to = reference.indexOf(end);
  if (from < 0 || to < from) fail(`missing family inventory markers for ${familyName}.`);
  const block = reference.slice(from + start.length, to);
  const names = new Set();
  for (const match of block.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) names.add(match[1]);
  return names;
};

const packages = [
  ['doxum', 'core/src/index.ts'],
  ['doxum/advanced', 'core/src/projection/advanced.ts'],
  ['doxum/react', 'react/src/index.ts'],
  ['doxum/local-sync', 'core/src/local-sync/index.ts'],
];

for (const [packageName, entry] of packages) {
  const actual = collectExports(entry);
  const documented = documentedExports(packageName);
  const missing = [...actual].filter(name => !documented.has(name)).sort();
  const stale = [...documented].filter(name => !actual.has(name)).sort();
  if (missing.length)
    fail(`${packageName} exports missing from public-api.md: ${missing.join(', ')}`);
  if (stale.length) fail(`${packageName} inventory contains non-exports: ${stale.join(', ')}`);
}

const actualKeyedMembers = collectObjectAssignMembers(
  'core/src/projection/derive/keyed.ts',
  'keyedDerive'
);
const documentedKeyedMembers = documentedFamily('derive.keyed');
const missingKeyedMembers = [...actualKeyedMembers]
  .filter(name => !documentedKeyedMembers.has(name))
  .sort();
const staleKeyedMembers = [...documentedKeyedMembers]
  .filter(name => !actualKeyedMembers.has(name))
  .sort();
if (missingKeyedMembers.length)
  fail(`derive.keyed members missing from public-api.md: ${missingKeyedMembers.join(', ')}`);
if (staleKeyedMembers.length)
  fail(`derive.keyed inventory contains non-members: ${staleKeyedMembers.join(', ')}`);

const skill = readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8');
const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
if (!frontmatter) fail('SKILL.md is missing YAML frontmatter.');
if (!/^name:\s*doxum-runtime\s*$/m.test(frontmatter[1]))
  fail('SKILL.md frontmatter must name doxum-runtime.');
if (!/^description:\s*\S.+$/m.test(frontmatter[1]))
  fail('SKILL.md frontmatter must contain a non-empty description.');

const markdownFiles = [
  resolve(skillRoot, 'SKILL.md'),
  ...readdirSync(resolve(skillRoot, 'references'))
    .filter(name => name.endsWith('.md'))
    .map(name => resolve(skillRoot, 'references', name)),
];
for (const file of markdownFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
    const target = resolve(dirname(file), match[1]);
    if (!existsSync(target))
      fail(`${relative(skillRoot, file)} links missing reference ${match[1]}`);
  }
}

const consumerReferences = [
  'references/public-api.md',
  'references/document-runtime.md',
  'references/projections.md',
  'references/integrations.md',
  'references/recipes.md',
];
const internalPath = /(?:core\/src\/|react\/src\/|dist\/)/;
for (const relativePath of consumerReferences) {
  const text = readFileSync(resolve(skillRoot, relativePath), 'utf8');
  if (internalPath.test(text)) fail(`${relativePath} depends on an internal source/build path.`);
}

console.log('Doxum runtime skill contract passed.');
