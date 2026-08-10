import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const FEATURE_ID = 'omnia.delete-elements';
const SOURCE_VERSION = '0.3.14';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function fail(message) { throw new Error(message); }
function parse(value, label) {
  try { return JSON.parse(String(value || '')); }
  catch (error) { fail(`${label} is invalid JSON: ${error.message}`); }
}
function sqlPath(value) { return String(value).replaceAll("'", "''"); }

const productRoot = path.resolve(argument('product-root') || path.join(import.meta.dirname, '..', 'releases'));
const runId = argument('run-id').toLowerCase();
if (!UUID.test(runId)) fail('Canonical --run-id is required.');
const corePath = path.join(productRoot, 'data', 'stores', 'core.sqlite');
const privatePath = path.join(productRoot, 'data', 'features', FEATURE_ID, 'store.sqlite');
const database = new DatabaseSync(corePath);
database.exec(`ATTACH DATABASE '${sqlPath(privatePath)}' AS feature_private`);

try {
  const run = database.prepare('SELECT * FROM feature_runs WHERE run_id=? AND feature_id=?').get(runId, FEATURE_ID);
  const privateRow = database.prepare('SELECT payload_json FROM feature_private.__runtime_plans WHERE plan_id=?').get(runId);
  const messageId = `delete-plan:${runId}`;
  const messageRow = database.prepare('SELECT * FROM feature_runtime_messages WHERE message_id=?').get(messageId);
  if (!run || !privateRow || !messageRow) fail('Legacy Run, private plan, or Comments card is unavailable.');
  const plan = parse(privateRow.payload_json, 'Legacy private plan');
  const card = parse(messageRow.payload_json, 'Legacy Comments card');
  if (String(run.state) === 'cancelled' && String(plan.state) === 'cancelled' && String(card.state) === 'cancelled') {
    console.log(JSON.stringify({ idempotent: true, runId, state: 'cancelled' }, null, 2));
    process.exit(0);
  }
  if (String(run.feature_version) !== SOURCE_VERSION || String(run.state) !== 'waiting_confirmation'
    || Number(run.state_revision) < 1 || !String(run.plan_digest || '')) fail('Legacy Run is not the exact pending confirmation candidate.');
  if (String(plan.runId) !== runId || String(plan.featureVersion) !== SOURCE_VERSION || String(plan.state) !== 'pending_confirmation'
    || String(plan.planDigest) !== String(run.plan_digest)) fail('Legacy private plan differs from the Core Run.');
  if (String(card.runId) !== runId || String(card.state) !== 'pending_confirmation') fail('Legacy Comments card differs from the pending plan.');
  const pendingConfirmations = database.prepare("SELECT COUNT(*) AS count FROM feature_confirmations WHERE run_id=? AND plan_digest=? AND decision='pending'")
    .get(runId, run.plan_digest).count;
  const frozenIntents = database.prepare("SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND plan_digest=? AND state='frozen'")
    .get(runId, run.plan_digest).count;
  const nonFrozenIntents = database.prepare("SELECT COUNT(*) AS count FROM managed_content_intents WHERE run_id=? AND state<>'frozen'").get(runId).count;
  const commands = database.prepare('SELECT COUNT(*) AS count FROM feature_commands WHERE run_id=?').get(runId).count;
  const receipts = database.prepare('SELECT COUNT(*) AS count FROM feature_operation_receipts WHERE run_id=?').get(runId).count;
  const reservations = database.prepare("SELECT COUNT(*) AS count FROM feature_mutation_reservations WHERE owner_run_id=? AND lifecycle='active'").get(runId).count;
  const lastRevision = database.prepare('SELECT MAX(revision) AS revision FROM feature_run_events WHERE run_id=?').get(runId).revision;
  if (Number(pendingConfirmations) !== 1 || Number(frozenIntents) < 1 || Number(nonFrozenIntents) !== 0
    || Number(commands) !== 0 || Number(receipts) !== 0 || Number(reservations) !== 0
    || Number(lastRevision) !== Number(run.state_revision)) {
    fail('Legacy plan has ambiguous confirmation, intent, command, receipt, reservation, or revision state.');
  }

  const occurredAt = new Date().toISOString();
  const reviewRevision = Number(run.state_revision) + 1;
  const cancelledRevision = reviewRevision + 1;
  const reason = 'DELETE.LEGACY_PLAN_MIGRATED: 0.3.14 pending Comments plan was cancelled before 0.3.15 activation; no mutation was submitted.';
  const terminalCard = {
    ...card,
    featureVersion: SOURCE_VERSION,
    stateVersion: Number(card.stateVersion || messageRow.state_version) + 1,
    state: 'cancelled',
    title: '已迁移取消',
    summary: '旧版待确认删除计划已在写入前安全取消；没有提交任何远端 mutation。后续计划、确认、进度和结果只在删除 Feature 卡片内显示。',
    details: [...(Array.isArray(card.details) ? card.details : []), { label: '迁移结果', value: reason }],
    actions: (Array.isArray(card.actions) ? card.actions : []).map((action) => ({
      ...action, enabled: false, reason: '旧计划已在写入前迁移取消。'
    }))
  };
  const terminalPlan = {
    ...plan,
    state: 'cancelled',
    stateVersion: Number(plan.stateVersion) + 1,
    invalidatedReason: reason,
    updatedAt: occurredAt
  };

  database.exec('BEGIN IMMEDIATE');
  try {
    const confirmationUpdate = database.prepare("UPDATE feature_confirmations SET decision='invalidated',actor_id='feature.navigation',decision_at=? WHERE run_id=? AND plan_digest=? AND decision='pending'")
      .run(occurredAt, runId, run.plan_digest);
    const intentUpdate = database.prepare("UPDATE managed_content_intents SET state='cancelled',updated_at=? WHERE run_id=? AND plan_digest=? AND state='frozen'")
      .run(occurredAt, runId, run.plan_digest);
    const reviewUpdate = database.prepare("UPDATE feature_runs SET state='ready_for_review',state_revision=?,plan_digest='',last_error='',updated_at=? WHERE run_id=? AND feature_id=? AND feature_version=? AND state='waiting_confirmation' AND state_revision=?")
      .run(reviewRevision, occurredAt, runId, FEATURE_ID, SOURCE_VERSION, Number(run.state_revision));
    if (confirmationUpdate.changes !== 1 || intentUpdate.changes !== Number(frozenIntents) || reviewUpdate.changes !== 1) {
      fail('Legacy confirmation changed before migration CAS.');
    }
    database.prepare('INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), runId, reviewRevision, 'waiting_confirmation', 'ready_for_review', 'return.confirmation_invalidated',
        JSON.stringify({ invalidatedConfirmations: 1, cancelledIntents: Number(frozenIntents), preservedArtifacts: true, preservedRevisions: true }), occurredAt);
    const cancelUpdate = database.prepare("UPDATE feature_runs SET state='cancelled',state_revision=?,last_error=?,updated_at=? WHERE run_id=? AND feature_id=? AND feature_version=? AND state='ready_for_review' AND state_revision=?")
      .run(cancelledRevision, reason, occurredAt, runId, FEATURE_ID, SOURCE_VERSION, reviewRevision);
    if (cancelUpdate.changes !== 1) fail('Legacy Run changed before cancellation CAS.');
    database.prepare('INSERT INTO feature_run_events(event_id,run_id,revision,from_state,to_state,event_type,details_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), runId, cancelledRevision, 'ready_for_review', 'cancelled', 'delete.legacy_comments_plan_migrated',
        JSON.stringify({ mutationSubmitted: false, remoteRollback: false, preservedAudit: true }), occurredAt);
    const planUpdate = database.prepare('UPDATE feature_private.__runtime_plans SET payload_json=?,updated_at=? WHERE plan_id=? AND payload_json=?')
      .run(JSON.stringify({ planId: runId, ...terminalPlan }), occurredAt, runId, privateRow.payload_json);
    const messageUpdate = database.prepare('UPDATE feature_runtime_messages SET state_version=?,payload_json=?,updated_at=? WHERE message_id=? AND state_version=?')
      .run(terminalCard.stateVersion, JSON.stringify(terminalCard), occurredAt, messageId, Number(messageRow.state_version));
    if (planUpdate.changes !== 1 || messageUpdate.changes !== 1) fail('Legacy private projection changed before migration CAS.');
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify({ idempotent: false, runId, state: 'cancelled', revision: cancelledRevision,
    cancelledIntents: Number(frozenIntents), mutationSubmitted: false }, null, 2));
} finally {
  database.close();
}
