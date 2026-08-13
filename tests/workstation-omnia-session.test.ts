import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConnectorOperationError, WorkstationOmniaSession, _test } from '../src/connector/workstation-omnia-session.ts';
import { isAllowedOmniaUrl, isGuid, parseEngagementId } from '../src/connector/omnia-origin.ts';

const engagementId = '11111111-1111-4111-8111-111111111111';

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

test('live hierarchy snapshot exposes only explicit canonical authority identities', async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'omnia-v5-authority-identity-'));const connector=new WorkstationOmniaSession(root,fetch);
  const page={url:()=>`https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`};
  const tenantId='44444444-4444-4444-8444-444444444444',packId='55555555-5555-4555-8555-555555555555';
  try{
    (connector as any).port=32123;(connector as any).cdpReady=async()=>true;(connector as any).currentPage=async()=>page;
    (connector as any).authByPage.set(page,{headers:{authorization:'Bearer live'},apiOrigin:'https://api.deloitteomnia.deloitte.com.cn',engagementId,identityMismatch:false});
    (connector as any).api=async()=>[{engagementId,name:'Live Pack',clientName:'Client',tenantId,packId}];
    const status=await connector.status();assert.equal(status.status,'connected');assert.equal(status.authorityInstanceId,'https://api.deloitteomnia.deloitte.com.cn');assert.equal(status.tenantOrOrgId,tenantId);assert.equal(status.packId,packId);
  }finally{await connector.close();rmSync(root,{recursive:true,force:true});}
});

test('signed Operation hierarchy proof is reused only for the exact Page, Pack, API origin and bearer', async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'omnia-v5-operation-identity-cache-'));const connector=new WorkstationOmniaSession(root,fetch);
  const page={url:()=>`https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`};
  let reads=0;
  try{
    (connector as any).api=async()=>{reads+=1;return[{engagementId,name:'Live Pack',clientName:'Client'}];};
    const base={page,targetUrl:new URL(page.url()),apiOrigin:'https://api.deloitteomnia.deloitte.com.cn',engagementId,headers:{authorization:'Bearer one'}};
    const first=await (connector as any).operationPackIdentity(base);
    const second=await (connector as any).operationPackIdentity(base);
    assert.deepEqual(second,first);assert.equal(reads,1,'unchanged exact binding must not re-read hierarchy per Operation');
    await (connector as any).operationPackIdentity({...base,headers:{authorization:'Bearer two'}});
    assert.equal(reads,2,'a bearer change must force a new authoritative hierarchy read');
  }finally{await connector.close();rmSync(root,{recursive:true,force:true});}
});

test('authority extraction uses the explicit hierarchy Engagement ID as the Pack identity and never display names',()=>{
  assert.deepEqual(_test.canonicalAuthorityIdentity('https://api.deloitteomnia.deloitte.com.cn',{engagementId,name:'Display Pack',clientName:'Display Client'}),{
    authorityInstanceId:'https://api.deloitteomnia.deloitte.com.cn',tenantOrOrgId:'',packId:engagementId
  });
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

test('status recovers a Pack switch as waiting_authorization instead of failing closed as identity_changed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-pack-switch-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  // The page already navigated to a new Pack, but the captured bearer still
  // belongs to the previous Pack and no allowlisted request for the new Pack
  // has been observed yet. That stale bearer is not proof of an identity
  // conflict — the switch must wait for re-authorization, not fail closed.
  const page = { url: () => `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home` };
  try {
    (connector as any).port = 32123;
    (connector as any).cdpReady = async () => true;
    (connector as any).currentPage = async () => page;
    (connector as any).authByPage.set(page, {
      headers: { authorization: 'Bearer previous-pack' },
      apiOrigin: 'https://api.deloitteomnia.deloitte.com.cn',
      engagementId: '22222222-2222-4222-8222-222222222222',
      identityMismatch: false
    });
    const status = await connector.status();
    assert.equal(status.status, 'waiting_authorization');
    assert.equal(status.connected, false);
    assert.equal(status.engagementId, engagementId);
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
    assert.deepEqual(connector.health(), { ready: true, connectorVersion: '0.3.36' });
  } finally {
    void connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refresh is a passive live status probe that preserves process, session, target, and Pack identity', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-passive-refresh-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  const packId = engagementId;
  const targetUrl = `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`;
  let currentUrl = targetUrl;
  let hierarchyReads = 0;
  const browserActions = { reload: 0, goto: 0, bringToFront: 0, newPage: 0, connect: 0 };
  const page = {
    url: () => currentUrl,
    reload: async () => { browserActions.reload += 1; },
    goto: async () => { browserActions.goto += 1; },
    bringToFront: async () => { browserActions.bringToFront += 1; }
  };
  try {
    (connector as any).port = 32123;
    (connector as any).cdpReady = async () => true;
    (connector as any).currentPage = async () => page;
    (connector as any).connect = async () => {
      browserActions.connect += 1;
      throw new Error('refresh must not call connect');
    };
    (connector as any).authByPage.set(page, {
      headers: { authorization: 'Bearer live' },
      apiOrigin: 'https://api.deloitteomnia.deloitte.com.cn',
      engagementId,
      identityMismatch: false
    });
    (connector as any).api = async () => {
      hierarchyReads += 1;
      return [{
        engagementId,
        name: 'Live Pack',
        clientName: 'Live Client',
        packId
      }];
    };
    const processId = process.pid;
    const before = await connector.status();
    const after = await connector.refresh();
    assert.equal(process.pid, processId);
    assert.equal(after.status, 'connected');
    assert.equal(after.sessionGeneration, before.sessionGeneration);
    assert.equal(after.engagementId, before.engagementId);
    assert.equal(after.packId, before.packId);
    assert.equal(currentUrl, targetUrl);
    assert.equal(hierarchyReads, 2);
    assert.deepEqual(browserActions, { reload: 0, goto: 0, bringToFront: 0, newPage: 0, connect: 0 });
  } finally {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('live status revokes stale Page Authorization instead of projecting cached Connected', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-live-status-auth-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  const page = { url: () => `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home` };
  let identityReads = 0;
  try {
    (connector as any).port = 32123;
    (connector as any).cdpReady = async () => true;
    (connector as any).currentPage = async () => page;
    (connector as any).authByPage.set(page, {
      headers: { authorization: 'Bearer expiring' },
      apiOrigin: 'https://api.deloitteomnia.deloitte.com.cn',
      engagementId,
      identityMismatch: false,
      captureEpoch: 1
    });
    (connector as any).identify = async () => {
      identityReads += 1;
      if (identityReads === 1) return {
        name: 'Live Pack', clientName: 'Live Client',
        authorityInstanceId: 'https://api.deloitteomnia.deloitte.com.cn',
        tenantOrOrgId: '', packId: engagementId
      };
      throw new ConnectorOperationError(
        'CONNECTOR.AUTH_REQUIRED',
        'Omnia read returned HTTP 401.'
      );
    };

    const first = await connector.status();
    assert.equal(first.status, 'connected');
    const second = await connector.status();
    assert.equal(second.status, 'waiting_authorization');
    assert.equal(second.connected, false);
    assert.equal((connector as any).authByPage.get(page), undefined);
    assert.equal(identityReads, 2);
  } finally {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit connect recaptures Authorization on an existing target without reload or navigation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-existing-target-rebind-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  const actions = { bringToFront: 0, reload: 0, goto: 0, newPage: 0 };
  const page = {
    url: () => `https://deloitteomnia.deloitte.com.cn/engagement/${engagementId}/home`,
    isClosed: () => false,
    bringToFront: async () => { actions.bringToFront += 1; },
    reload: async () => { actions.reload += 1; },
    goto: async () => { actions.goto += 1; }
  };
  try {
    (connector as any).ensureBrowser = async () => ({
      contexts: () => [{ newPage: async () => { actions.newPage += 1; return page; } }]
    });
    (connector as any).currentPage = async () => page;
    (connector as any).status = async () => (connector as any).authByPage.get(page)
      ? { status: 'connected', connected: true }
      : { status: 'waiting_authorization', connected: false };
    (connector as any).waitForAuthorization = async () => {
      (connector as any).authByPage.set(page, {
        headers: { authorization: 'Bearer renewed' },
        apiOrigin: 'https://api.deloitteomnia.deloitte.com.cn',
        engagementId,
        identityMismatch: false,
        captureEpoch: 2
      });
      return true;
    };

    const result = await connector.connect();
    assert.equal(result.status, 'connected');
    assert.deepEqual(actions, { bringToFront: 1, reload: 0, goto: 0, newPage: 0 });
  } finally {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refresh reports target_closed without creating or connecting a page', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'omnia-v5-passive-target-closed-'));
  const connector = new WorkstationOmniaSession(root, fetch);
  try {
    (connector as any).port = 32123;
    (connector as any).cdpReady = async () => true;
    (connector as any).currentPage = async () => null;
    (connector as any).connect = async () => { throw new Error('refresh must not call connect'); };
    (connector as any).ensureBrowser = async () => { throw new Error('refresh must not start or attach a browser'); };
    const status = await connector.refresh();
    assert.equal(status.status, 'target_closed');
    assert.equal(status.connected, false);
  } finally {
    await connector.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('refresh source contains only the passive status path and no browser lifecycle action', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '../src/connector/workstation-omnia-session.ts'),
    'utf8'
  );
  const start = source.indexOf('async refresh(): Promise<ConnectorConnection>');
  const end = source.indexOf('async workspaceAuthorityRead(', start);
  assert.ok(start >= 0 && end > start);
  const refreshSource = source.slice(start, end);
  assert.match(refreshSource, /return this\.status\(\)/);
  assert.doesNotMatch(
    refreshSource,
    /\.reload\s*\(|\.goto\s*\(|\.bringToFront\s*\(|\.newPage\s*\(|this\.connect\s*\(|this\.ensureBrowser\s*\(|this\.currentPage\s*\(/
  );
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
