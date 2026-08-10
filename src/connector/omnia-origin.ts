const OMNIA_HOST_SUFFIXES = Object.freeze([
  'omnia.example.invalid',
  'aaps.deloitte.com.cn'
]);

export function normalizeOmniaUrl(value: string, label = 'Omnia URL'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} 无效。`);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || !OMNIA_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
  ) throw new Error(`${label} 必须使用受信 Deloitte Omnia HTTPS 域名。`);
  url.hostname = hostname;
  return url;
}

export function isAllowedOmniaUrl(value: string): boolean {
  try {
    normalizeOmniaUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function parseEngagementId(value: string): string {
  try {
    return new URL(value).pathname.match(/\/engagement\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]?.toLowerCase() || '';
  } catch {
    return '';
  }
}

export function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    && value.toLowerCase() !== '00000000-0000-0000-0000-000000000000';
}
