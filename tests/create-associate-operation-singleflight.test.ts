import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOperationHandler } = require('../feature-packages/create-associate/source/connector-capability/operation/handler.cjs') as {
  createOperationHandler: () => { run: (operationId: string, request: unknown, sdk: unknown) => Promise<unknown> };
};

test('identical concurrent signed directory reads share only the in-flight request', async () => {
  const handler = createOperationHandler();
  const riskAssessmentId = '11111111-1111-4111-8111-111111111111';
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  let calls = 0;
  const sdk = {
    binding: { connectorId: 'connector', sessionGeneration: 7, engagementId: '33333333-3333-4333-8333-333333333333' },
    invokeStep: async (stepId: string) => {
      assert.equal(stepId, 'risk-factor-directory');
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { riskFactors: [
        { id: '44444444-4444-4444-8444-444444444444', displayOrder: 2, name: 'Factor A', applicable: true, riskLevel: { value: 1 }, riskLevelSpectrum: [{value: 1}, {value: 7}] },
        { id: '55555555-5555-4555-8555-555555555555', displayOrder: 3, name: 'Factor B', applicable: true, riskLevel: { value: 1 }, riskLevelSpectrum: [{value: 1}, {value: 7}] }
      ] };
    }
  };
  const request = (order: string, label: string) => ({
    target: { targetIdentityKey: `risk-factor-${order}`, workspaceId },
    query: { riskAssessmentId, itemId: `APP.RF.DISPLAY_ORDER_${order}`, itemLabel: label, selectionMode: 'Higher', contentName: 'Generic' }
  });
  const first = await Promise.all([
    handler.run('omnia.create-associate.risk-factor.preflight.v1', request('02', 'Factor A'), sdk),
    handler.run('omnia.create-associate.risk-factor.preflight.v1', request('03', 'Factor B'), sdk)
  ]);
  assert.equal(first.length, 2);
  assert.equal(calls, 1);
  await handler.run('omnia.create-associate.risk-factor.preflight.v1', request('02', 'Factor A'), sdk);
  assert.equal(calls, 2, 'a settled read must not become a stale cache entry');
});
