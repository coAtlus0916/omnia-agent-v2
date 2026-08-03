import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('homepage does not expose business feature entries', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.tsx'), 'utf8');
  for (const forbiddenLabel of [
    '附加 Feature',
    '录制',
    '删除元素',
    '删除聊天记录',
    '新建与关联',
    'Phase 1',
    'Phase 2',
    'Controls'
  ]) {
    assert.equal(renderer.includes(forbiddenLabel), false, `unexpected homepage label: ${forbiddenLabel}`);
  }
});

test('Connector settings and anonymous discovery are absent; pairing lives in the top Connect detail flow', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.tsx'), 'utf8');
  assert.doesNotMatch(renderer, /Connector 连接模式|Bridge URL|候选 Connector ID|查找并匹配|setConnectionMode|pairRemote/);
  assert.match(renderer, /function RemoteConnectionDialog/);
  assert.match(renderer, /remote-pairing-code/);
  assert.match(renderer, /diagnoseRemoteConnection/);
  assert.match(renderer, /beginRemotePairing\(\{ repair: true, confirmed: true/);
  assert.match(renderer, /revokeRemoteBinding\(\{ confirmed: true/);
  assert.match(renderer, /window\.confirm\(/);
  assert.match(renderer, /pollRemotePairing/);
});
