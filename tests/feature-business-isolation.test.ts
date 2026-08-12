import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

type FeatureSpec = {
  readonly directory: string;
  readonly featureId: string;
  readonly packageScript: string;
};

const FEATURES: readonly FeatureSpec[] = [
  {
    directory: 'create-associate',
    featureId: 'omnia.create-associate',
    packageScript: 'scripts/package-create-associate-feature.mjs'
  },
  {
    directory: 'delete-elements',
    featureId: 'omnia.delete-elements',
    packageScript: 'scripts/package-delete-feature.mjs'
  },
  {
    directory: 'recording',
    featureId: 'omnia.recording',
    packageScript: 'scripts/package-recording-feature.mjs'
  },
  {
    directory: 'workpaper-preparation',
    featureId: 'omnia.workpaper-preparation',
    packageScript: 'scripts/package-workpaper-preparation-feature.mjs'
  }
] as const;

type ViolationKind =
  | 'cross-feature-import'
  | 'cross-feature-path'
  | 'cross-feature-id'
  | 'cross-feature-version'
  | 'shared-business-module'
  | 'copied-business-function'
  | 'copied-engine'
  | 'shared-engine-entry'
  | 'shared-bridge-entry'
  | 'shared-state-path'
  | 'shared-state-namespace'
  | 'source-link'
  | 'missing-runtime-entry';

type Violation = {
  readonly kind: ViolationKind;
  readonly feature: string;
  readonly file: string;
  readonly detail: string;
};

type FunctionFingerprint = {
  readonly feature: string;
  readonly file: string;
  readonly name: string;
  readonly line: number;
  readonly fingerprint: string;
  readonly protocolBoilerplate: boolean;
};

type StateBinding = {
  readonly feature: string;
  readonly file: string;
  readonly name: string;
  readonly value: string;
};

const productionTextExtensions = new Set(['.cjs', '.js', '.json', '.mjs', '.py', '.ts', '.tsx']);
const javascriptExtensions = new Set(['.cjs', '.js', '.mjs', '.ts', '.tsx']);
const ignoredSourceDirectories = new Set(['__pycache__', 'docs', 'node_modules', 'tests']);
const commonStateLeafNames = new Set(['store.sqlite']);
const commonStateEnvironmentNames = new Set(['OMNIA_FEATURE_STORE_PATH']);
const minimumJavascriptFunctionLength = 200;
const minimumPythonFunctionLength = 90;

function slash(value: string): string {
  return value.replaceAll('\\', '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function implementationFingerprint(source: string): string {
  const normalized = source.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function isProtocolBoilerplate(filename: string): boolean {
  const basename = path.basename(filename, path.extname(filename));
  return /^(?:canonical|codec|contracts?|protocol|serialization|serializer|wire)(?:[._-]|$)/i.test(basename);
}

function collectProductionFiles(
  projectRoot: string,
  feature: FeatureSpec,
  violations: Violation[]
): string[] {
  const sourceRoot = path.join(projectRoot, 'feature-packages', feature.directory, 'source');
  const result: string[] = [];
  const visit = (directory: string): void => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoredSourceDirectories.has(entry.name)) continue;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        violations.push({
          kind: 'source-link',
          feature: feature.featureId,
          file: slash(path.relative(projectRoot, target)),
          detail: 'Feature production source must not be shared through a symlink or junction.'
        });
        continue;
      }
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && productionTextExtensions.has(path.extname(entry.name).toLowerCase())) result.push(target);
    }
  };
  visit(sourceRoot);
  return result.sort();
}

function platformContractImport(projectRoot: string, resolved: string): boolean {
  if (!isInside(resolved, projectRoot)) return false;
  const relative = slash(path.relative(projectRoot, resolved));
  return /^src\/shared\/(?:[a-z0-9-]+-)?contracts?\.(?:c?js|mjs|ts)$/i.test(relative)
    || /^src\/shared\/(?:ipc|wire)(?:-[a-z0-9-]+)?\.(?:c?js|mjs|ts)$/i.test(relative);
}

function moduleSpecifiers(filename: string, source: string): string[] {
  if (!javascriptExtensions.has(path.extname(filename).toLowerCase())) return [];
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind(filename));
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      result.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && argument && ts.isStringLiteralLike(argument)) result.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function scanImports(
  projectRoot: string,
  feature: FeatureSpec,
  filename: string,
  source: string,
  violations: Violation[]
): void {
  const ownPackageRoot = path.join(projectRoot, 'feature-packages', feature.directory);
  for (const specifier of moduleSpecifiers(filename, source)) {
    const importedFeature = FEATURES.find((candidate) => candidate.directory !== feature.directory
      && (new RegExp(`(?:^|[/@])${escapeRegExp(candidate.directory)}(?:$|[/])`, 'i').test(specifier)
        || specifier.includes(candidate.featureId)));
    if (importedFeature) {
      violations.push({
        kind: 'cross-feature-import',
        feature: feature.featureId,
        file: slash(path.relative(projectRoot, filename)),
        detail: `Imports ${importedFeature.featureId} through ${specifier}.`
      });
      continue;
    }
    if (!specifier.startsWith('.') && !path.isAbsolute(specifier)) continue;
    const resolved = path.resolve(path.dirname(filename), specifier);
    const owner = FEATURES.find((candidate) => isInside(
      resolved,
      path.join(projectRoot, 'feature-packages', candidate.directory)
    ));
    if (owner && owner.directory !== feature.directory) {
      violations.push({
        kind: 'cross-feature-import',
        feature: feature.featureId,
        file: slash(path.relative(projectRoot, filename)),
        detail: `Imports ${owner.featureId} through ${specifier}.`
      });
    } else if (!isInside(resolved, ownPackageRoot) && !platformContractImport(projectRoot, resolved)) {
      violations.push({
        kind: 'shared-business-module',
        feature: feature.featureId,
        file: slash(path.relative(projectRoot, filename)),
        detail: `Imports ${specifier}; only the owning package or an allowlisted general src/shared contract/IPC module is permitted.`
      });
    }
  }
}

function scanCrossFeatureReferences(
  projectRoot: string,
  feature: FeatureSpec,
  filename: string,
  source: string,
  violations: Violation[]
): void {
  const relativeFile = slash(path.relative(projectRoot, filename));
  for (const other of FEATURES) {
    if (other.directory === feature.directory) continue;
    const id = escapeRegExp(other.featureId);
    const semver = 'v?\\d+\\.\\d+\\.\\d+(?:-[0-9a-z.-]+)?';
    const versionReference = new RegExp(`(?:${id}[\\s\\S]{0,120}${semver}|${semver}[\\s\\S]{0,120}${id})`, 'i');
    if (versionReference.test(source)) {
      violations.push({
        kind: 'cross-feature-version',
        feature: feature.featureId,
        file: relativeFile,
        detail: `References the release identity/version of ${other.featureId}.`
      });
    } else if (new RegExp(`(?:^|[^a-z0-9.-])${id}(?:$|[^a-z0-9.-])`, 'i').test(source)) {
      violations.push({
        kind: 'cross-feature-id',
        feature: feature.featureId,
        file: relativeFile,
        detail: `References ${other.featureId}; Feature-to-Feature identity coupling is forbidden.`
      });
    }

    const directory = escapeRegExp(other.directory);
    const repositoryPath = new RegExp(`feature-packages[\\\\/]${directory}(?:[\\\\/]|\\b)`, 'i');
    const relativePath = new RegExp(`(?:\\.\\.[\\\\/])+${directory}[\\\\/]`, 'i');
    if (repositoryPath.test(source) || relativePath.test(source)) {
      violations.push({
        kind: 'cross-feature-path',
        feature: feature.featureId,
        file: relativeFile,
        detail: `References the private package path of ${other.featureId}.`
      });
    }
  }
}

function javascriptFunctionFingerprints(
  projectRoot: string,
  feature: FeatureSpec,
  filename: string,
  source: string
): FunctionFingerprint[] {
  if (!javascriptExtensions.has(path.extname(filename).toLowerCase())) return [];
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind(filename));
  const result: FunctionFingerprint[] = [];
  const visit = (node: ts.Node): void => {
    const supported = ts.isFunctionDeclaration(node)
      || ts.isFunctionExpression(node)
      || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node)
      || ts.isConstructorDeclaration(node);
    if (supported) {
      const normalized = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
      if (normalized.length >= minimumJavascriptFunctionLength) {
        let name = '<anonymous>';
        if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.name) {
          name = node.name.getText(sourceFile);
        } else if (ts.isConstructorDeclaration(node)) {
          name = 'constructor';
        }
        result.push({
          feature: feature.featureId,
          file: slash(path.relative(projectRoot, filename)),
          name,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          fingerprint: implementationFingerprint(normalized),
          protocolBoilerplate: isProtocolBoilerplate(filename)
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function indentationWidth(line: string): number {
  const indentation = /^\s*/.exec(line)?.[0] ?? '';
  return indentation.replaceAll('\t', '    ').length;
}

function scriptKind(filename: string): ts.ScriptKind {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.tsx') return ts.ScriptKind.TSX;
  if (extension === '.ts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function pythonFunctionFingerprints(
  projectRoot: string,
  feature: FeatureSpec,
  filename: string,
  source: string
): FunctionFingerprint[] {
  if (path.extname(filename).toLowerCase() !== '.py') return [];
  const lines = source.split(/\r?\n/);
  const result: FunctionFingerprint[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const declaration = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (!declaration) continue;
    const baseIndent = indentationWidth(line);
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end] ?? '';
      if (candidate.trim() && indentationWidth(candidate) <= baseIndent) break;
      end += 1;
    }
    const normalized = lines.slice(index, end).join('\n').replace(/\s+/g, ' ').trim();
    if (normalized.length < minimumPythonFunctionLength) continue;
    result.push({
      feature: feature.featureId,
      file: slash(path.relative(projectRoot, filename)),
      name: declaration[1] ?? '<anonymous>',
      line: index + 1,
      fingerprint: implementationFingerprint(normalized),
      protocolBoilerplate: isProtocolBoilerplate(filename)
    });
  }
  return result;
}

function stateBindings(
  projectRoot: string,
  feature: FeatureSpec,
  filename: string,
  source: string
): { paths: StateBinding[]; namespaces: StateBinding[] } {
  const paths: StateBinding[] = [];
  const namespaces: StateBinding[] = [];
  const relativeFile = slash(path.relative(projectRoot, filename));
  const add = (name: string, value: string): void => {
    const normalizedName = name.replaceAll('-', '_').toUpperCase();
    const normalizedValue = slash(value.trim());
    if (!normalizedValue || commonStateEnvironmentNames.has(normalizedValue)) return;
    if (/NAMESPACE/.test(normalizedName)) {
      namespaces.push({ feature: feature.featureId, file: relativeFile, name, value: normalizedValue });
    }
    if (/(?:STATE|STORE|DATABASE|DB).*(?:PATH|FILE)|(?:STATE|STORE|DATABASE|DB)_PATH/.test(normalizedName)
      && !commonStateLeafNames.has(normalizedValue.toLowerCase())) {
      paths.push({ feature: feature.featureId, file: relativeFile, name, value: normalizedValue.toLowerCase() });
    }
  };

  const assignment = /\b([A-Za-z_][A-Za-z0-9_-]*(?:namespace|state_path|store_path|database_path|db_path|state_file|store_file|database_file|db_file)[A-Za-z0-9_-]*)\s*[:=]\s*['"]([^'"]+)['"]/gi;
  for (const match of source.matchAll(assignment)) add(match[1] ?? '', match[2] ?? '');
  const joinedAssignment = /\b([A-Za-z_][A-Za-z0-9_-]*(?:state_path|store_path|database_path|db_path|state_file|store_file|database_file|db_file)[A-Za-z0-9_-]*)\s*[:=]\s*(?:path\.join|os\.path\.join)\s*\(([^)]*)\)/gi;
  for (const match of source.matchAll(joinedAssignment)) {
    const argumentsSource = match[2] ?? '';
    const literalArguments = [...argumentsSource.matchAll(/['"]([^'"]+)['"]/g)].map((item) => item[1] ?? '');
    const residue = argumentsSource.replace(/['"][^'"]+['"]/g, '').replace(/[\s,]/g, '');
    if (literalArguments.length && residue === '') add(match[1] ?? '', literalArguments.join('/'));
  }
  const databaseLiteral = /(?:sqlite3\.connect|new\s+Database(?:Sync)?)\s*\(\s*['"]([^'"]+)['"]/gi;
  for (const match of source.matchAll(databaseLiteral)) add('database_path', match[1] ?? '');
  return { paths, namespaces };
}

function duplicateStateViolations(
  bindings: readonly StateBinding[],
  kind: 'shared-state-path' | 'shared-state-namespace'
): Violation[] {
  const groups = new Map<string, StateBinding[]>();
  for (const binding of bindings) {
    const group = groups.get(binding.value) ?? [];
    group.push(binding);
    groups.set(binding.value, group);
  }
  const result: Violation[] = [];
  for (const [value, group] of groups) {
    if (new Set(group.map((item) => item.feature)).size < 2) continue;
    const references = [...new Set(group.map((item) => `${item.feature}:${item.file}:${item.name}`))].sort();
    result.push({ kind, feature: references.map((item) => item.split(':', 1)[0]).join(','), file: references.join(', '), detail: `Shared state identity ${JSON.stringify(value)}.` });
  }
  return result;
}

function duplicateFunctionViolations(fingerprints: readonly FunctionFingerprint[]): Violation[] {
  const groups = new Map<string, FunctionFingerprint[]>();
  for (const fingerprint of fingerprints) {
    const group = groups.get(fingerprint.fingerprint) ?? [];
    group.push(fingerprint);
    groups.set(fingerprint.fingerprint, group);
  }
  const result: Violation[] = [];
  for (const group of groups.values()) {
    const features = [...new Set(group.map((item) => item.feature))].sort();
    if (features.length < 2 || group.every((item) => item.protocolBoilerplate)) continue;
    const references = [...new Set(group.map((item) => `${item.feature}:${item.file}:${item.line}:${item.name}`))].sort();
    result.push({
      kind: 'copied-business-function',
      feature: features.join(','),
      file: references.join(', '),
      detail: 'Exact production function implementation is owned by more than one Feature.'
    });
  }
  return result;
}

function runtimeEntries(
  projectRoot: string,
  feature: FeatureSpec,
  packageSource: string,
  property: 'bridgePath' | 'entryPath',
  violations: Violation[]
): string[] {
  const values = [...packageSource.matchAll(new RegExp(`\\b${property}\\s*:\\s*['"]([^'"]+)['"]`, 'g'))]
    .map((match) => slash(match[1] ?? ''));
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    violations.push({
      kind: 'missing-runtime-entry',
      feature: feature.featureId,
      file: feature.packageScript,
      detail: `${property} must have exactly one auditable literal value; found ${unique.length}.`
    });
  }
  const sourceRoot = path.join(projectRoot, 'feature-packages', feature.directory, 'source');
  for (const value of unique) {
    const resolved = path.resolve(sourceRoot, value);
    if (!isInside(resolved, sourceRoot) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      violations.push({
        kind: 'missing-runtime-entry',
        feature: feature.featureId,
        file: feature.packageScript,
        detail: `${property} entry ${value} is missing or escapes its owning source root.`
      });
    }
  }
  return unique;
}

function duplicateEntryViolations(
  entries: ReadonlyMap<string, readonly string[]>,
  kind: 'shared-engine-entry' | 'shared-bridge-entry'
): Violation[] {
  const values = new Map<string, string[]>();
  for (const [feature, paths] of entries) {
    for (const entry of paths) {
      const basename = path.posix.basename(entry).toLowerCase();
      const owners = values.get(basename) ?? [];
      owners.push(`${feature}:${entry}`);
      values.set(basename, owners);
    }
  }
  const result: Violation[] = [];
  for (const [basename, owners] of values) {
    if (owners.length < 2) continue;
    result.push({ kind, feature: owners.map((owner) => owner.split(':', 1)[0]).join(','), file: owners.join(', '), detail: `Runtime entry basename ${basename} is shared.` });
  }
  return result;
}

export function auditFeatureBusinessIsolation(projectRoot: string): Violation[] {
  const violations: Violation[] = [];
  const fingerprints: FunctionFingerprint[] = [];
  const statePaths: StateBinding[] = [];
  const stateNamespaces: StateBinding[] = [];
  const engineEntries = new Map<string, readonly string[]>();
  const bridgeEntries = new Map<string, readonly string[]>();
  const engineFingerprints = new Map<string, { feature: string; file: string }[]>();

  for (const feature of FEATURES) {
    const files = collectProductionFiles(projectRoot, feature, violations);
    for (const filename of files) {
      const source = fs.readFileSync(filename, 'utf8');
      scanImports(projectRoot, feature, filename, source, violations);
      scanCrossFeatureReferences(projectRoot, feature, filename, source, violations);
      fingerprints.push(...javascriptFunctionFingerprints(projectRoot, feature, filename, source));
      fingerprints.push(...pythonFunctionFingerprints(projectRoot, feature, filename, source));
      const bindings = stateBindings(projectRoot, feature, filename, source);
      statePaths.push(...bindings.paths);
      stateNamespaces.push(...bindings.namespaces);
    }

    const packageFilename = path.join(projectRoot, feature.packageScript);
    if (!fs.existsSync(packageFilename)) {
      violations.push({ kind: 'missing-runtime-entry', feature: feature.featureId, file: feature.packageScript, detail: 'Feature packaging lifecycle script is missing.' });
      continue;
    }
    const packageSource = fs.readFileSync(packageFilename, 'utf8');
    scanCrossFeatureReferences(projectRoot, feature, packageFilename, packageSource, violations);
    const entries = runtimeEntries(projectRoot, feature, packageSource, 'entryPath', violations);
    const bridges = runtimeEntries(projectRoot, feature, packageSource, 'bridgePath', violations);
    engineEntries.set(feature.featureId, entries);
    bridgeEntries.set(feature.featureId, bridges);
    const sourceRoot = path.join(projectRoot, 'feature-packages', feature.directory, 'source');
    for (const entry of entries) {
      const resolved = path.resolve(sourceRoot, entry);
      if (!isInside(resolved, sourceRoot) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue;
      const fingerprint = implementationFingerprint(fs.readFileSync(resolved, 'utf8'));
      const group = engineFingerprints.get(fingerprint) ?? [];
      group.push({ feature: feature.featureId, file: slash(path.relative(projectRoot, resolved)) });
      engineFingerprints.set(fingerprint, group);
    }
  }

  violations.push(...duplicateFunctionViolations(fingerprints));
  violations.push(...duplicateStateViolations(statePaths, 'shared-state-path'));
  violations.push(...duplicateStateViolations(stateNamespaces, 'shared-state-namespace'));
  violations.push(...duplicateEntryViolations(engineEntries, 'shared-engine-entry'));
  violations.push(...duplicateEntryViolations(bridgeEntries, 'shared-bridge-entry'));
  for (const group of engineFingerprints.values()) {
    if (new Set(group.map((item) => item.feature)).size < 2) continue;
    violations.push({
      kind: 'copied-engine',
      feature: group.map((item) => item.feature).sort().join(','),
      file: group.map((item) => `${item.feature}:${item.file}`).sort().join(', '),
      detail: 'Exact normalized engine content is owned by more than one Feature.'
    });
  }

  return violations.sort((left, right) => `${left.kind}:${left.file}`.localeCompare(`${right.kind}:${right.file}`));
}

function formatViolations(violations: readonly Violation[]): string {
  return violations.map((item) => `${item.kind} | ${item.feature} | ${item.file} | ${item.detail}`).join('\n');
}

function writeFixtureFile(root: string, relative: string, contents: string): void {
  const filename = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents, 'utf8');
}

function withFixture(overrides: Readonly<Record<string, string>>, callback: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omnia-feature-business-isolation-'));
  try {
    writeFixtureFile(root, 'src/shared/contracts.ts', "export const schemaVersion = 'omnia.platform-contract/v1';\n");
    FEATURES.forEach((feature, index) => {
      const engineName = `${feature.directory}-engine.py`;
      const bridgeName = `${feature.directory}-bridge.cjs`;
      writeFixtureFile(root, `feature-packages/${feature.directory}/source/python/${engineName}`, `def ${feature.directory.replaceAll('-', '_')}_engine(value):\n    return value + ${index}\n`);
      writeFixtureFile(root, `feature-packages/${feature.directory}/source/middle/${bridgeName}`, `module.exports = { bridge: '${feature.featureId}' };\n`);
      writeFixtureFile(root, `feature-packages/${feature.directory}/source/middle/worker.cjs`, `module.exports = { feature: '${feature.featureId}' };\n`);
      writeFixtureFile(root, feature.packageScript, [
        `const source = ['feature-packages', '${feature.directory}', 'source'];`,
        `const output = ['feature-packages', '${feature.directory}', 'candidates'];`,
        `const runtime = { entryPath: 'python/${engineName}', bridgePath: 'middle/${bridgeName}' };`,
        'void source; void output; void runtime;'
      ].join('\n'));
    });
    for (const [relative, contents] of Object.entries(overrides)) writeFixtureFile(root, relative, contents);
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function kinds(root: string): Set<ViolationKind> {
  return new Set(auditFeatureBusinessIsolation(root).map((item) => item.kind));
}

test('release gate: the four production Features own business, engine, state, version and lifecycle independently', () => {
  const violations = auditFeatureBusinessIsolation(repositoryRoot);
  assert.equal(violations.length, 0, `Feature business isolation violations:\n${formatViolations(violations)}`);
});

test('negative fixture: a cross-package import is rejected', () => {
  withFixture({
    'feature-packages/create-associate/source/middle/worker.cjs': "module.exports = require('../../../delete-elements/source/middle/worker.cjs');\n"
  }, (root) => assert.ok(kinds(root).has('cross-feature-import')));
  withFixture({
    'feature-packages/create-associate/source/middle/worker.cjs': "module.exports = require('@omnia/delete-elements');\n"
  }, (root) => assert.ok(kinds(root).has('cross-feature-import')));
});

test('negative fixture: copied JavaScript business functions are rejected', () => {
  const copied = `function buildBusinessPlan(rows) {
    const accepted = [];
    for (const row of rows) {
      if (!row || row.disabled === true) continue;
      const amount = Number(row.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid business amount');
      accepted.push({ objectId: String(row.objectId), amount, decision: amount > 100 ? 'review' : 'accept' });
    }
    return accepted.sort((left, right) => left.objectId.localeCompare(right.objectId));
  }
  module.exports = { buildBusinessPlan };
`;
  withFixture({
    'feature-packages/create-associate/source/middle/worker.cjs': copied,
    'feature-packages/delete-elements/source/middle/worker.cjs': copied
  }, (root) => assert.ok(kinds(root).has('copied-business-function')));
});

test('negative fixture: copied Python business functions and copied engines are rejected', () => {
  const copied = `def compile_business_plan(rows):
    accepted = []
    for row in rows:
        if row.get("disabled") is True:
            continue
        amount = int(row["amount"])
        if amount < 0:
            raise ValueError("invalid business amount")
        accepted.append({"objectId": str(row["objectId"]), "amount": amount})
    return sorted(accepted, key=lambda item: item["objectId"])
`;
  withFixture({
    'feature-packages/create-associate/source/python/create-associate-engine.py': copied,
    'feature-packages/recording/source/python/recording-engine.py': copied
  }, (root) => {
    const actual = kinds(root);
    assert.ok(actual.has('copied-business-function'));
    assert.ok(actual.has('copied-engine'));
  });
});

test('negative fixture: shared state paths and namespaces are rejected', () => {
  const literalState = `const BUSINESS_STATE_PATH = '../shared/business-state.sqlite';
const BUSINESS_STATE_NAMESPACE = 'shared-business-state';
module.exports = { BUSINESS_STATE_PATH, BUSINESS_STATE_NAMESPACE };
`;
  const joinedState = `const BUSINESS_STATE_PATH = path.join('..', 'shared', 'business-state.sqlite');
const BUSINESS_STATE_NAMESPACE = 'shared-business-state';
module.exports = { BUSINESS_STATE_PATH, BUSINESS_STATE_NAMESPACE };
`;
  withFixture({
    'feature-packages/delete-elements/source/middle/worker.cjs': literalState,
    'feature-packages/workpaper-preparation/source/middle/worker.cjs': joinedState
  }, (root) => {
    const actual = kinds(root);
    assert.ok(actual.has('shared-state-path'));
    assert.ok(actual.has('shared-state-namespace'));
  });
});

test('negative fixture: a cross-package version dependency is rejected', () => {
  withFixture({
    'feature-packages/workpaper-preparation/source/middle/worker.cjs': "const requiredFeature = { featureId: 'omnia.recording', minimumVersion: '0.4.19' }; module.exports = { requiredFeature };\n"
  }, (root) => assert.ok(kinds(root).has('cross-feature-version')));
});

test('negative fixture: shared engine and bridge entry names are rejected even under separate package roots', () => {
  withFixture({
    'scripts/package-create-associate-feature.mjs': "const runtime = { entryPath: 'python/create-associate-engine.py', bridgePath: 'middle/shared-bridge.cjs' };\n",
    'scripts/package-delete-feature.mjs': "const runtime = { entryPath: 'python/create-associate-engine.py', bridgePath: 'middle/shared-bridge.cjs' };\n",
    'feature-packages/delete-elements/source/python/create-associate-engine.py': 'def delete_engine(value):\n    return value - 1\n',
    'feature-packages/create-associate/source/middle/shared-bridge.cjs': "module.exports = { bridge: 'create' };\n",
    'feature-packages/delete-elements/source/middle/shared-bridge.cjs': "module.exports = { bridge: 'delete' };\n"
  }, (root) => {
    const actual = kinds(root);
    assert.ok(actual.has('shared-engine-entry'));
    assert.ok(actual.has('shared-bridge-entry'));
  });
});

test('protocol/serialization boilerplate and allowlisted platform contracts do not count as shared business', () => {
  const protocol = `def encode_frame(payload):
    normalized = {key: payload[key] for key in sorted(payload)}
    body = str(normalized).encode("utf-8")
    if len(body) > 1024 * 1024:
        raise ValueError("frame too large")
    return len(body).to_bytes(4, "big") + body
`;
  withFixture({
    'feature-packages/create-associate/source/python/protocol.py': protocol,
    'feature-packages/delete-elements/source/python/protocol.py': protocol,
    'feature-packages/create-associate/source/middle/worker.cjs': "module.exports = require('../../../../src/shared/contracts.ts');\n"
  }, (root) => {
    const violations = auditFeatureBusinessIsolation(root);
    assert.ok(!violations.some((item) => item.kind === 'copied-business-function'));
    assert.ok(!violations.some((item) => item.kind === 'shared-business-module'));
  });
});
