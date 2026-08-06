import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteCommandGate, validateConnectorWireRequest } from '../src/remote-connector/wire-request.ts';

const request = (id: string, operation: string, payload: Record<string, unknown> = {}) => ({
  schemaVersion: 'omnia.connector-ipc/v1',
  id,
  operation,
  payload
});

test('Remote Connector rejects unknown operations instead of returning ok with undefined', async () => {
  assert.throws(
    () => validateConnectorWireRequest(request('req-1', 'arbitrary_mutation')),
    (error: any) => error.code === 'CONNECTOR.UNKNOWN_OPERATION'
  );
  const gate = new RemoteCommandGate();
  let dispatched = false;
  const response = await gate.handle(request('req-1', 'arbitrary_mutation'), async () => {
    dispatched = true;
  });
  assert.equal(dispatched, false);
  assert.equal(response.ok, false);
  assert.equal(response.error?.code, 'CONNECTOR.UNKNOWN_OPERATION');
});

test('Remote Connector validates payloads, preserves request identity, and allows bounded independent calls', async () => {
  assert.throws(
    () => validateConnectorWireRequest(request('req-2', 'health', { unexpected: true })),
    (error: any) => error.code === 'CONNECTOR.INVALID_PAYLOAD'
  );
  const gate = new RemoteCommandGate();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let dispatches = 0;
  const first = gate.handle(request('req-3', 'connect'), async () => {
    dispatches += 1;
    await pending;
    return { ready: true };
  });
  const duplicate = await gate.handle(request('req-3', 'status'), async () => {
    dispatches += 1;
    return {};
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error?.code, 'CONNECTOR.DUPLICATE_IN_FLIGHT');
  assert.equal(dispatches, 1);
  const exclusive = await gate.handle(request('req-5', 'refresh'), async () => ({ status: 'connected' }));
  assert.equal(exclusive.ok, false);
  assert.equal(exclusive.error?.code, 'CONNECTOR.BUSY');
  release();
  assert.equal((await first).ok, true);
  const second = await gate.handle(request('req-4', 'status'), async () => {
    dispatches += 1;
    return { status: 'waiting' };
  });
  assert.equal(second.ok, true);
  assert.equal(dispatches, 2);
});

test('Remote wire gate admits only the generic Operation host schemas and rejects retired feature commands', () => {
  assert.throws(() => validateConnectorWireRequest(request('recording-1', 'recording_command', {
    schemaVersion: 'omnia.v5.recording-command/v1',
    featureId: 'omnia.recording',
    featureVersion: '0.1.0',
    kind: 'status',
    connectorBinding: {
      connectorId: 'v5-remote-connector',
      sessionGeneration: 1,
      engagementId: 'engagement-1'
    }
  })), (error: any) => error.code === 'CONNECTOR.UNKNOWN_OPERATION');
  assert.equal(validateConnectorWireRequest(request('operation-1', 'operation_register', {
    schemaVersion: 'omnia.operation-registration/v1',
    featureId: 'official.feature',
    featureVersion: '1.0.0',
    operationPackage: {}
  })).operation, 'operation_register');
  assert.throws(() => validateConnectorWireRequest(request('operation-2', 'operation_invoke', {
    schemaVersion: 'not-official'
  })), (error: any) => error.code === 'CONNECTOR.INVALID_PAYLOAD');
});
