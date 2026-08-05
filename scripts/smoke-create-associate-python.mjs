import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required.`);
  return path.resolve(process.argv[index + 1]);
}

const productRoot = argument('--root');
const workbookPath = argument('--workbook');
const outputPath = argument('--output');
const databasePath = path.join(productRoot, 'data', 'stores', 'core.sqlite');
const runtime = path.join(productRoot, 'runtime', 'python', 'cpython-3.13.14-embed-amd64', 'python.exe');
for (const required of [workbookPath, databasePath, runtime]) {
  if (!fs.existsSync(required) || !fs.statSync(required).isFile()) throw new Error(`Smoke input is missing: ${required}`);
}

const database = new DatabaseSync(databasePath, { readOnly: true });
const head = database.prepare(`
  SELECT feature_version,runtime_enabled,runtime_reason,package_path
  FROM feature_activation_heads WHERE feature_id='omnia.create-associate'
`).get();
database.close();
if (!head || head.feature_version !== '0.2.43' || head.runtime_enabled !== 1) {
  throw new Error(`Create/associate Python runtime is not active: ${head?.runtime_reason || 'missing head'}`);
}
const packageRoot = path.resolve(productRoot, 'data', ...String(head.package_path).split('/'));
const entry = path.join(packageRoot, 'python', 'engine.py');
const bridgePath = path.join(packageRoot, 'middle', 'python-bridge.cjs');
const governancePath = path.join(packageRoot, 'backend', 'governance.json');
const runtimeBasePath = path.join(packageRoot, 'backend', 'runtime-template-base.xlsx');
for (const required of [entry, bridgePath, governancePath, runtimeBasePath]) {
  if (!fs.existsSync(required) || !fs.statSync(required).isFile()) throw new Error(`Installed Feature member is missing: ${required}`);
}

const runId = randomUUID();
const tempRoot = path.resolve(productRoot, 'data', 'temp', 'acceptance-python', runId);
const tempParent = path.resolve(productRoot, 'data', 'temp', 'acceptance-python');
if (!tempRoot.startsWith(`${tempParent}${path.sep}`)) throw new Error('Smoke temp root escaped the portable product.');
fs.mkdirSync(tempRoot, { recursive: true });

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function inputHandle(bytes, filename) {
  const handleId = randomUUID();
  const directory = path.join(tempRoot, runId, handleId);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, filename);
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  return { schemaVersion: 'omnia.python-artifact-handle/v1', handleId, runId, path: target, access: 'read', sizeBytes: bytes.length, sha256: digest(bytes) };
}

function outputHandle(filename) {
  const handleId = randomUUID();
  const directory = path.join(tempRoot, runId, handleId);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, filename);
  fs.writeFileSync(target, Buffer.alloc(0), { flag: 'wx' });
  return { schemaVersion: 'omnia.python-artifact-handle/v1', handleId, runId, path: target, access: 'write', sizeBytes: 0, sha256: '' };
}

process.env.OMNIA_MANAGED_PYTHON_EXECUTABLE = runtime;
process.env.OMNIA_MANAGED_PYTHON_ENTRY = entry;
process.env.OMNIA_FEATURE_PACKAGE_ROOT = packageRoot;
process.env.OMNIA_FEATURE_TEMP_ROOT = tempRoot;
const require = createRequire(import.meta.url);
const { createPythonSidecarBridge } = require(bridgePath);
const bridge = createPythonSidecarBridge({
  ports: {
    connector: { invoke: async () => { throw new Error('Pure data smoke must not call Connector.'); } },
    store: { call: async () => true },
    events: { emit: async () => true }
  }
});

try {
  const workbookBytes = fs.readFileSync(workbookPath);
  const governanceBytes = fs.readFileSync(governancePath);
  const sourceArtifactId = randomUUID();
  const parsed = await bridge.invoke('parse_workbook', {
    schemaVersion: 'omnia.create-associate.python-operation/v1',
    workbookHandle: inputHandle(workbookBytes, 'input.xlsx'),
    sourceArtifactId,
    governanceHandle: inputHandle(governanceBytes, 'governance.json'),
    resultHandle: outputHandle('parsed.json')
  }, { runId });
  if (!parsed || parsed.schemaVersion !== 'omnia.create-associate.parsed-workbook/v1') throw new Error('Parsed workbook contract is invalid.');
  const compiledOutput = outputHandle('runtime-instance.xlsx');
  const compiled = await bridge.invoke('compile_workbook', {
    schemaVersion: 'omnia.create-associate.python-operation/v1',
    baseWorkbookHandle: inputHandle(fs.readFileSync(runtimeBasePath), 'runtime-base.xlsx'),
    parsedHandle: inputHandle(Buffer.from(JSON.stringify(parsed), 'utf8'), 'parsed.json'),
    metadata: { runId, traceId: randomUUID(), sourceArtifactId, governanceDigest: digest(governanceBytes) },
    outputWorkbookHandle: compiledOutput
  }, { runId });
  if (!compiled?.workbook || compiled.artifact?.handleId !== compiledOutput.handleId) throw new Error('Compiled workbook contract is invalid.');
  const outputBytes = fs.readFileSync(compiledOutput.path);
  if (digest(outputBytes) !== compiled.workbook.sha256 || outputBytes.length !== compiled.workbook.sizeBytes) throw new Error('Compiled workbook bytes drifted.');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(compiledOutput.path, outputPath, fs.constants.COPYFILE_EXCL);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    featureVersion: head.feature_version,
    rows: parsed.rows.length,
    candidates: parsed.candidates.length,
    issues: parsed.issues.length,
    sheetNames: compiled.workbook.sheetNames,
    sizeBytes: outputBytes.length,
    sha256: compiled.workbook.sha256,
    outputPath
  }, null, 2)}\n`);
} finally {
  await bridge.close();
  if (!tempRoot.startsWith(`${tempParent}${path.sep}`)) throw new Error('Refusing to clean an unbounded smoke path.');
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
