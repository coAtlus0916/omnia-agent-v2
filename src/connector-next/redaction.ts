const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'password', 'secret', 'token', 'credential', 'enrollmentcode', 'pollproof', 'apikey'
]);

function safeKey(value: string): string {
  return value.toLowerCase().replaceAll('_', '').replaceAll('-', '');
}

export function redactConnectorNextDetails(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, 40)) {
    if (SENSITIVE_KEYS.has(safeKey(key))) {
      output[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      output[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    } else if (depth < 2 && value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redactConnectorNextDetails(value, depth + 1);
    } else if (Array.isArray(value)) {
      output[key] = value.slice(0, 20).map((item) => (
        typeof item === 'string' ? item.slice(0, 200) : typeof item === 'number' || typeof item === 'boolean' ? item : '[OBJECT]'
      ));
    }
  }
  return output;
}
