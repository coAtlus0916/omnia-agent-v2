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

test('paired Remote Connector state hides the one-time discovery action', () => {
  const renderer = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.tsx'), 'utf8');
  assert.match(renderer, /connection\.remotePaired \? <div className="pair-result paired-success">/);
  assert.match(renderer, /已匹配 Remote Connector/);
  assert.match(renderer, /关闭设置后点击顶部“连接”，无需再次查找/);
  const pairedBranch = renderer.indexOf('connection.remotePaired ? <div className="pair-result paired-success">');
  const unpairedBranch = renderer.indexOf('</div> : <>', pairedBranch);
  const discoveryAction = renderer.indexOf('查找并匹配 Remote Connector', unpairedBranch);
  assert.ok(pairedBranch >= 0 && unpairedBranch > pairedBranch && discoveryAction > unpairedBranch);
});
