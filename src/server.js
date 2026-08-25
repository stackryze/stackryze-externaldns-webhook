import express from 'express';
import { listZones, listRecords, batch, strip } from './stackryze.js';

const app = express();
app.use(express.json({ type: () => true, limit: '4mb' })); // ExternalDNS sends a custom media type

const MEDIA_TYPE = 'application/external.dns.webhook+json;version=1';
const PORT = parseInt(process.env.PORT || '8888');
const MIN_TTL = 3600;
const MAX_TTL = 604800;

const clampTtl = (t) => {
  const n = parseInt(t) || 0;
  if (n < MIN_TTL) return MIN_TTL;
  if (n > MAX_TTL) return MAX_TTL;
  return n;
};

// Map a FQDN to the owning zone + relative label.
function resolveZone(zones, dnsName) {
  const name = strip(dnsName).toLowerCase();
  let best = null;
  for (const z of zones) {
    const zn = z.name.toLowerCase();
    if (name === zn || name.endsWith(`.${zn}`)) {
      if (!best || z.name.length > best.name.length) best = z;
    }
  }
  if (!best) return null;
  const label = name === best.name.toLowerCase() ? '@' : name.slice(0, -(best.name.length + 1));
  return { zone: best, label };
}

// TXT content must be quoted for our API.
function toContent(type, target) {
  const t = strip(target);
  if (type === 'TXT') return t.startsWith('"') ? t : `"${t}"`;
  return t;
}

function endpointRecords(zones, ep) {
  const resolved = resolveZone(zones, ep.dnsName);
  if (!resolved) return null;
  const ttl = clampTtl(ep.recordTTL);
  return {
    zoneId: resolved.zone.id,
    label: resolved.label,
    type: ep.recordType,
    ttl,
    contents: (ep.targets || []).map((t) => toContent(ep.recordType, t)),
  };
}

app.use((req, res, next) => { res.type(MEDIA_TYPE); next(); });

// Negotiation: advertise the zones we manage as the domain filter.
app.get('/', async (_req, res) => {
  try {
    const zones = await listZones();
    res.status(200).send(JSON.stringify({ filters: zones.map((z) => z.name) }));
  } catch (err) {
    console.error('negotiate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Return all records across managed zones as ExternalDNS endpoints.
app.get('/records', async (_req, res) => {
  try {
    const zones = await listZones();
    const flat = (await Promise.all(zones.map((z) => listRecords(z.id, z.name)))).flat();
    // Group into endpoints keyed by dnsName + type.
    const map = new Map();
    for (const r of flat) {
      const key = `${r.name}|${r.type}`;
      if (!map.has(key)) map.set(key, { dnsName: r.name, recordType: r.type, recordTTL: r.ttl, targets: [] });
      const ep = map.get(key);
      ep.targets.push(r.type === 'TXT' ? r.content.replace(/^"|"$/g, '') : r.content);
      ep.recordTTL = Math.min(ep.recordTTL || r.ttl, r.ttl);
    }
    res.status(200).send(JSON.stringify([...map.values()]));
  } catch (err) {
    console.error('records error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Apply a set of changes (plan.Changes). Grouped into one batch per zone.
app.post('/records', async (req, res) => {
  try {
    const body = req.body || {};
    const create = body.Create || body.create || [];
    const updateOld = body.UpdateOld || body.updateOld || [];
    const updateNew = body.UpdateNew || body.updateNew || [];
    const del = body.Delete || body.delete || [];

    const zones = await listZones();
    const perZone = new Map(); // zoneId -> { create: [], delete: [] }
    const ensure = (id) => { if (!perZone.has(id)) perZone.set(id, { create: [], delete: [] }); return perZone.get(id); };

    const addCreate = (ep) => {
      const r = endpointRecords(zones, ep);
      if (!r) { console.warn(`No managed zone for ${ep.dnsName}, skipping`); return; }
      for (const content of r.contents) ensure(r.zoneId).create.push({ name: r.label, type: r.type, content, ttl: r.ttl });
    };
    const addDelete = (ep) => {
      const r = endpointRecords(zones, ep);
      if (!r) return;
      for (const content of r.contents) ensure(r.zoneId).delete.push({ name: r.label, type: r.type, content });
    };

    create.forEach(addCreate);
    del.forEach(addDelete);
    updateOld.forEach(addDelete);
    updateNew.forEach(addCreate);

    for (const [zoneId, ops] of perZone) {
      const result = await batch(zoneId, ops.create, ops.delete);
      if (result.errors?.length) console.warn(`zone ${zoneId}: ${result.errors.length} error(s)`, result.errors.slice(0, 3));
    }
    res.status(204).end();
  } catch (err) {
    console.error('apply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ExternalDNS asks the provider to normalize endpoints before planning.
app.post('/adjustendpoints', (req, res) => {
  const endpoints = Array.isArray(req.body) ? req.body : [];
  const adjusted = endpoints.map((ep) => ({ ...ep, recordTTL: clampTtl(ep.recordTTL) }));
  res.status(200).send(JSON.stringify(adjusted));
});

app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

app.listen(PORT, () => console.log(`Stackryze ExternalDNS webhook provider listening on :${PORT}`));
