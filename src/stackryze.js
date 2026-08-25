// Thin client for the Stackryze DNS REST API using a Bearer token.
const BASE = (process.env.STACKRYZE_API_URL || 'https://api-dns.stackryze.com/api').replace(/\/$/, '');
const TOKEN = process.env.STACKRYZE_API_TOKEN;

if (!TOKEN) {
  console.error('FATAL: STACKRYZE_API_TOKEN is required');
  process.exit(1);
}

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.error || `${res.status} ${res.statusText}`;
    throw new Error(`Stackryze API ${method} ${path} failed: ${msg}`);
  }
  return data;
}

const strip = (s) => (s && s.endsWith('.') ? s.slice(0, -1) : s);

export async function listZones() {
  const data = await call('GET', '/zones');
  return (data.zones || data || []).map((z) => ({ id: z._id, name: strip(z.name) }));
}

// Returns flattened records: { name (fqdn), type, ttl, content }.
export async function listRecords(zoneId, zoneName) {
  const rrsets = await call('GET', `/zones/${zoneId}/records?max=1000`);
  const out = [];
  for (const rr of rrsets || []) {
    const fqdn = strip(rr.name);
    for (const r of rr.records || []) {
      if (r.disabled) continue;
      out.push({ name: fqdn, type: rr.type, ttl: rr.ttl, content: strip(r.content), zoneId, zoneName });
    }
  }
  return out;
}

// create/delete: arrays of { name (label), type, content, ttl }
export async function batch(zoneId, create, del) {
  if (create.length === 0 && del.length === 0) return { created: 0, deleted: 0, errors: [] };
  return call('POST', `/zones/${zoneId}/records/batch`, { create, delete: del });
}

export { strip };
