import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkstationOmniaSession, _test } from '../src/connector/workstation-omnia-session.ts';
import { isAllowedOmniaUrl, isGuid, parseEngagementId } from '../src/connector/omnia-origin.ts';

const engagementId = '11111111-1111-4111-8111-111111111111';
const sectionId = '22222222-2222-4222-8222-222222222222';
const workspaceId = '33333333-3333-4333-8333-333333333333';

test('Omnia origin allowlist rejects arbitrary hosts and extracts only canonical engagement routes', () => {
  assert.equal(isAllowedOmniaUrl('https://deloitteomnia.deloitte.com.cn/engagement/x'), true);
  assert.equal(isAllowedOmniaUrl('https://evil.example/engagement/x'), false);
  assert.equal(
    parseEngagementId(`https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`),
    engagementId
  );
  assert.equal(isGuid('aaaaaaaa-aaaa-0000-0000-aaaaaaaaaaaa'), true);
  assert.equal(isGuid('00000000-0000-0000-0000-000000000000'), false);
});

test('workspace light read requires explicit Section to Workspace identities', () => {
  const result = _test.normalizeLightRead(
    engagementId,
    [{
      id: sectionId,
      label: '真实 Section',
      workspaces: [{ workspaceFacetId: workspaceId, sectionId }]
    }],
    [{ id: workspaceId, name: '任意显示名称', isDeleted: false }]
  );
  assert.equal(result.sections[0]?.id, sectionId);
  assert.equal(result.workspaces[0]?.parentSectionId, sectionId);
  assert.equal(result.profile, 'workspace_light_read');
});

test('workspace light read fails closed when only names are available', () => {
  assert.throws(
    () => _test.normalizeLightRead(
      engagementId,
      [{ id: sectionId, label: '20000 IT Elements' }],
      [{ id: workspaceId, name: 'TEST' }]
    ),
    (error: any) =>
      error.code === 'WORKSPACE.AUTHORITY_HIERARCHY_UNAVAILABLE'
      && /缺少权威 parentSectionId/.test(error.message)
  );
});

test('target binding rejects multiple Pack pages instead of selecting the first', () => {
  assert.throws(
    () => _test.selectUniqueTargetIndex([
      `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`,
      'https://deloitteomnia.deloitte.com.cn/engagement/aaaaaaaa-aaaa-0000-0000-aaaaaaaaaaaa/home'
    ]),
    (error: any) => error.code === 'CONNECTOR.MULTIPLE_PACK_TARGETS'
  );
  assert.equal(_test.selectUniqueTargetIndex([
    `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`
  ]), 0);
});

test('Authorization is bound to the exact target Engagement and rejects identity drift', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';
  const target = `https://deloitteomnia.deloitte.com.cn/engagement/${first}/home`;
  assert.deepEqual(
    _test.authorizationEngagementId(`https://api.deloitteomnia.deloitte.com.cn/work/v1/engagements/${first}/items`, target),
    { engagementId: first, identityMismatch: false }
  );
  assert.deepEqual(
    _test.authorizationEngagementId(`https://api.deloitteomnia.deloitte.com.cn/engagements/v1/${second}/headers/hierarchy`, target),
    { engagementId: second, identityMismatch: true }
  );
});

test('SSO/new-tab handoff accepts one Pack only in the bound browser context', () => {
  const pack = `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`;
  assert.equal(_test.selectSafeTargetIndex([
    { url: 'https://deloitteomnia.deloitte.com.cn/login', contextId: 1 },
    { url: pack, contextId: 1 }
  ], 0), 1);
  assert.throws(
    () => _test.selectSafeTargetIndex([
      { url: 'https://deloitteomnia.deloitte.com.cn/login', contextId: 1 },
      { url: pack, contextId: 2 }
    ], 0),
    (error: any) => error.code === 'CONNECTOR.MULTIPLE_PACK_TARGETS'
  );
  assert.equal(_test.selectSafeTargetIndex([
    { url: 'https://login.microsoftonline.com/tenant/oauth2/authorize', contextId: 1 },
    { url: pack, contextId: 1 }
  ], 0), 1);
});

test('external enterprise IdP navigation remains waiting_login and is never trusted as a Pack', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-external-sso-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  const page = { url: () => 'https://login.microsoftonline.com/tenant/oauth2/authorize' };
  try {
    (connector as any).port = 32123;
    (connector as any).cdpReady = async () => true;
    (connector as any).currentPage = async () => page;
    const status = await connector.status();
    assert.equal(status.status, 'waiting_login');
    assert.equal(status.connected, false);
    assert.equal(status.engagementId, '');
  } finally {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('status fails closed as identity_changed when stale Authorization belongs to another Engagement', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-stale-auth-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  const page = { url: () => `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home` };
  try {
    (connector as any).port = 32123;
    (connector as any).cdpReady = async () => true;
    (connector as any).currentPage = async () => page;
    (connector as any).authByPage.set(page, {
      headers: { authorization: 'Bearer stale' },
      apiOrigin: 'https://api.deloitteomnia.deloitte.com.cn',
      engagementId: '22222222-2222-4222-8222-222222222222',
      identityMismatch: true
    });
    const status = await connector.status();
    assert.equal(status.status, 'identity_changed');
    assert.equal(status.connected, false);
  } finally {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('CDP identity must bind the exact profile and dynamically selected port', () => {
  const profile = path.resolve('C:\\omnia-v5-data\\connector\\edge-profile');
  assert.equal(_test.browserIdentityMatches([
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=51234'
  ], profile, 51234), true);
  assert.equal(_test.browserIdentityMatches([
    '--user-data-dir=C:\\unrelated-profile',
    '--remote-debugging-port=51234'
  ], profile, 51234), false);
  assert.equal(_test.browserIdentityMatches([
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=9223'
  ], profile, 51234), false);
});

test('Workstation Session Core health is self-contained and does not start a browser', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-connector-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  try {
    assert.deepEqual(connector.health(), { ready: true, connectorVersion: '0.3.5' });
  } finally {
    void connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('closing Connector never closes or terminates the controlled Edge session', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-close-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  let browserCloseCalls = 0;
  let processKillCalls = 0;
  (connector as any).browser = { close: async () => { browserCloseCalls += 1; } };
  (connector as any).browserProcess = { killed: false, kill: () => { processKillCalls += 1; } };
  await connector.close();
  assert.equal(browserCloseCalls, 0);
  assert.equal(processKillCalls, 0);
  rmSync(root, { recursive: true, force: true });
});
