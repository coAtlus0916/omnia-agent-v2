// Read-only diagnostics for the create-associate "Return" execution path.
// It aggregates the interaction_logs already written by the signed-operation
// wrapper and prints where a Return actually spent its time: request volume,
// per-operation latency, and per-trace Risk/Control totals. No code change is
// needed and no business payload is read; only durations and operation IDs.
//
// Usage:
//   node scripts/diagnose-create-return-slow.mjs [--product-root <path>] [--trace <traceId>]
//
// `--product-root` defaults to ./releases (the portable product root). Point it
// at the directory whose data/stores/core.sqlite holds the run to diagnose.
// `--trace` narrows the timeline to one interaction trace.

import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

const productRoot = path.resolve(argument('product-root') || path.join(import.meta.dirname, '..', 'releases'));
const traceFilter = argument('trace').trim();
const corePath = path.join(productRoot, 'data', 'stores', 'core.sqlite');

const database = new DatabaseSync(corePath, { readOnly: true });
try {
  const table = database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='interaction_logs'"
  ).get().count;
  if (Number(table) !== 1) {
    throw new Error(`interaction_logs table not found in ${corePath}`);
  }

  const round = (value) => Number(Number(value).toFixed(1));

  const operationTotals = database.prepare(`
    SELECT operation_id, action, COUNT(*) AS n,
           ROUND(AVG(duration_ms),1) AS avg_ms,
           MAX(duration_ms) AS max_ms,
           ROUND(SUM(duration_ms)/1000.0,1) AS total_s
    FROM interaction_logs
    WHERE operation_id LIKE '%risk-control%'
       OR operation_id LIKE '%risk-classification%'
       OR operation_id LIKE '%risk-factor%'
       OR operation_id LIKE '%evaluation%'
       OR operation_id LIKE '%gra%'
    GROUP BY operation_id, action
    ORDER BY total_s DESC
  `).all().map((row) => ({ ...row, avg_ms: round(row.avg_ms), max_ms: round(row.max_ms), total_s: round(row.total_s) }));

  const slowTraces = database.prepare(`
    SELECT trace_id, COUNT(*) AS risk_control_calls,
           ROUND(SUM(duration_ms)/1000.0,1) AS total_s
    FROM interaction_logs
    WHERE operation_id IN (
      'omnia.create-associate.risk-control.associate.v1',
      'omnia.create-associate.risk-control.preflight.v1',
      'omnia.create-associate.risk-control.reconcile.v1'
    )
    GROUP BY trace_id
    ORDER BY total_s DESC
    LIMIT 10
  `).all().map((row) => ({ ...row, total_s: round(row.total_s) }));

  const latencyBuckets = database.prepare(`
    SELECT
      CASE
        WHEN duration_ms < 1000 THEN '0-1s'
        WHEN duration_ms < 3000 THEN '1-3s'
        WHEN duration_ms < 6000 THEN '3-6s'
        WHEN duration_ms < 10000 THEN '6-10s'
        ELSE '>10s'
      END AS bucket,
      COUNT(*) AS n
    FROM interaction_logs
    WHERE operation_id='omnia.create-associate.risk-control.associate.v1'
    GROUP BY bucket
    ORDER BY MIN(duration_ms)
  `).all();

  let timeline = null;
  if (traceFilter) {
    timeline = database.prepare(`
      SELECT action, operation_id, COUNT(*) AS n,
             ROUND(SUM(duration_ms)/1000.0,1) AS sum_s,
             MIN(timestamp) AS first_start,
             MAX(completed_at) AS last_end
      FROM interaction_logs
      WHERE trace_id=? AND (operation_id LIKE '%risk%' OR operation_id LIKE '%gra%' OR operation_id LIKE '%evaluation%')
      GROUP BY action, operation_id
      ORDER BY first_start
    `).all(traceFilter).map((row) => ({ ...row, sum_s: round(row.sum_s) }));
  }

  console.log(JSON.stringify({
    corePath,
    traceFilter: traceFilter || null,
    operationTotals,
    slowestTraces: slowTraces,
    riskControlAssociateLatencyBuckets: latencyBuckets,
    timeline: timeline || undefined
  }, null, 2));
} finally {
  database.close();
}
