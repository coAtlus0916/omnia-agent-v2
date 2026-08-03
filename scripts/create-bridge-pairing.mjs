const bridgeUrl = String(process.env.OMNIA_V5_BRIDGE_PUBLIC_URL || '').trim();
const adminToken = String(process.env.OMNIA_V5_BRIDGE_ADMIN_TOKEN || '').trim();
if (!bridgeUrl || !adminToken) {
  throw new Error('OMNIA_V5_BRIDGE_PUBLIC_URL and OMNIA_V5_BRIDGE_ADMIN_TOKEN are required.');
}
const response = await fetch(new URL('v1/admin/pairing-bundles', bridgeUrl.endsWith('/') ? bridgeUrl : `${bridgeUrl}/`), {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
  signal: AbortSignal.timeout(20_000)
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.message || `Bridge returned HTTP ${response.status}.`);
process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
