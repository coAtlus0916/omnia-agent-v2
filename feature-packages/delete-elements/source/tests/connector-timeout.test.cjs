'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createFeatureWorker } = require('../middle/worker.cjs');

function canonical(value) {
  if (value === null || ['boolean', 'string', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function digest(value) { return crypto.createHash('sha256').update(canonical(value)).digest('hex'); }

const workspaceId = '11111111-1111-1111-1111-111111111111';
const connectorBinding = { connectorId: 'connector-timeout', sessionGeneration: 3,
  engagementId: '33333333-3333-3333-3333-333333333333', authorityInstanceId: 'https://authority.example.invalid',
  tenantOrOrgId: 'tenant-timeout', packId: 'pack-timeout' };
const safetyLock = { enabled: true, validForCurrentConnection: true, globalEnabled: false, ...connectorBinding,
  stateVersion: 9, authorityObservationId: 'observation-timeout', workspaceIds: [workspaceId] };
const context = { connectorBinding, safetyLock };

test('a hung Connector Operation fails closed within the bounded response window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = createFeatureWorker({
    connector: { invoke: async () => new Promise(() => {}) },
    store: { call: async () => { throw new Error('store should not be reached before the scope read returns'); } },
    events: { emit: async () => undefined }
  });
  t.after(() => worker.shutdown());
  const pending = worker.refreshCatalog(context);
  await t.mock.timers.tick(130_000);
  await assert.rejects(pending, (error) => error.code === 'DELETE.CONNECTOR_TIMEOUT');
});
