// /api/avisos.js
// npm i fast-xml-parser undici
import { XMLParser } from 'fast-xml-parser';
import { fetch } from 'undici';

const FEED_URL = 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain';

// Parser XML común
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true, // cap: -> cap
  trimValues: true,
});

/** Extrae enlaces a CAP desde un Atom/RSS, robusto con/ sin .xml */
function parseFeedForCapLinks(xml) {
  const obj = parser.parse(xml || '');
  const links = new Set();

  // Atom
  const entries = obj?.feed?.entry ? (Array.isArray(obj.feed.entry) ? obj.feed.entry : [obj.feed.entry]) : [];
  for (const e of entries) {
    const ls = e?.link ? (Array.isArray(e.link) ? e.link : [e.link]) : [];
    for (const l of ls) {
      // l puede ser objeto {href,type,rel,...} o string
      const href = l?.href ?? (typeof l === 'string' ? l : '');
      const type = String(l?.type || '').toLowerCase();
      if (!href) continue;

      const looksCap =
        type.includes('cap+xml') ||
        type.includes('application/xml') ||
        /\.xml($|\?)/i.test(href) ||
        /\/warnings\//i.test(href) ||             // patrón típico de Meteoalarm
        /application\/(atom|rss)\+xml/i.test(type);// fallback

      if (looksCap) links.add(href);
    }

    // algunos feeds meten url CAP en <id> o <content>
    if (typeof e?.id === 'string') {
      const id = e.id;
      if (/\.xml($|\?)/i.test(id) || /\/warnings\//i.test(id)) links.add(id);
    }
    const c = e?.content;
    if (typeof c === 'string') {
      if (/^https?:\/\//.test(c) && (/\.xml($|\?)/i.test(c) || /\/warnings\//i.test(c))) links.add(c);
    } else if (c?.src || c?.url) {
      const u = c.src || c.url;
      if (/\.xml($|\?)/i.test(u) || /\/warnings\//i.test(u)) links.add(u);
    }
  }

  // RSS (por si acaso)
  const ch = obj?.rss?.channel;
  if (ch?.item) {
    const items = Array.isArray(ch.item) ? ch.item : [ch.item];
    for (const it of items) {
      for (const cand of [it.link, it.guid, it?.guid?.['#text']].filter(Boolean)) {
        const s = String(cand);
        if (/\.xml($|\?)/i.test(s) || /\/warnings\//i.test(s)) links.add(s);
      }
    }
  }

  return Array.from(links);
}

/** Convierte texto "lat,lon lat,lon ..." (CAP) -> [[lon,lat], ...] y cierra anillo */
function parseCapPolygon(polyText) {
  if (!polyText) return null;
  const pairs = polyText.split(/\s+/).map(p => p.trim()).filter(Boolean);
  const coords = [];
  for (const pair of pairs) {
    const [latStr, lonStr] = pair.split(',').map(Number);
    if (Number.isFinite(latStr) && Number.isFinite(lonStr)) coords.push([lonStr, latStr]);
  }
  if (coords.length >= 3) {
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    return coords;
  }
  return null;
}

/** Centroid sencillo para fallback a Point */
function centroid(coords) {
  let x = 0, y = 0, n = 0;
  for (const [lon, lat] of coords) { x += lon; y += lat; n++; }
  return n ? [x / n, y / n] : null;
}

/** CAP -> array de GeoJSON Features (una por área/polígono) */
function capToFeatures(capXml) {
  const o = parser.parse(capXml || '');
  const alert = o?.alert;
  if (!alert) return [];

  const infoArr = alert.info ? (Array.isArray(alert.info) ? alert.info : [alert.info]) : [];
  const common = {
    identifier: alert.identifier,
    sender: alert.sender,
    sent: alert.sent,
    status: alert.status,
    msgType: alert.msgType || alert.message_type,
    scope: alert.scope,
  };

  const feats = [];

  for (const info of infoArr) {
    const areas = info?.area ? (Array.isArray(info.area) ? info.area : [info.area]) : [null];
    // propiedades comunes de info
    const propsBase = {
      ...common,
      language: info?.language,
      category: info?.category,
      event: info?.event,
      responseType: info?.responseType,
      urgency: info?.urgency,
      severity: info?.severity,
      certainty: info?.certainty,
      effective: info?.effective,
      onset: info?.onset,
      expires: info?.expires,
      headline: info?.headline,
      description: info?.description,
      instruction: info?.instruction,
      web: info?.web,
      contact: info?.contact,
    };

    for (const area of areas) {
      const areaDesc = area?.areaDesc;
      const polygons = area?.polygon
        ? (Array.isArray(area.polygon) ? area.polygon : [area.polygon])
        : [];
      const circles = area?.circle
        ? (Array.isArray(area.circle) ? area.circle : [area.circle])
        : [];

      // geocodes EMMA_ID etc.
      const geocodes = {};
      const gcArr = area?.geocode ? (Array.isArray(area.geocode) ? area.geocode : [area.geocode]) : [];
      for (const gc of gcArr) {
        const k = gc?.valueName || gc?.valuename || gc?.name;
        const v = gc?.value;
        if (k && v) geocodes[k] = v;
      }

      if (polygons.length) {
        for (const p of polygons) {
          const ring = parseCapPolygon(p);
          if (ring) {
            feats.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: [ring] },
              properties: { ...propsBase, areaDesc, geocodes },
            });
          }
        }
      } else if (circles.length) {
        // círculo "lat,lon radius" (km según CAP 1.2 – a veces metros). Fallback a Point.
        for (const c of circles) {
          const m = String(c).match(/^\s*([+-]?\d+(\.\d+)?),\s*([+-]?\d+(\.\d+)?)\s+([+-]?\d+(\.\d+)?)\s*$/);
          if (m) {
            const lat = parseFloat(m[1]), lon = parseFloat(m[3]);
            feats.push({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [lon, lat] },
              properties: { ...propsBase, areaDesc, geocodes, circle: c },
            });
          }
        }
      } else if (areaDesc) {
        // sin geometría: punto ficticio (no ideal). Puedes omitir si no quieres “puntos huérfanos”.
        // Aquí lo dejamos vacío para no “ensuciar” el mapa:
        feats.push({
          type: 'Feature',
          geometry: null,
          properties: { ...propsBase, areaDesc, geocodes },
        });
      }
    }
  }
  return feats;
}

async function fetchText(u) {
  const r = await fetch(u, { headers: { 'user-agent': 'goodbarber-meteoapp/1.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${u}`);
  return r.text();
}

async function gatherCaps(feedUrl) {
  const xml = await fetchText(feedUrl);
  const links = parseFeedForCapLinks(xml);

  // Concurrency limitada
  const MAX = 8;
  const out = [];
  let i = 0;
  async function worker() {
    while (i < links.length) {
      const idx = i++;
      const url = links[idx];
      try {
        const cap = await fetchText(url);
        out.push({ url, cap });
      } catch (e) {
        // continúa con las demás
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX, links.length) }, worker));
  return out;
}

export default async function handler(req, res) {
  try {
    const feed = req.query.feed || FEED_URL;
    const caps = await gatherCaps(feed);

    const features = [];
    for (const { cap } of caps) {
      try {
        features.push(...capToFeatures(cap));
      } catch {}
    }

    // filtra features sin geometría si quieres solo pintar en mapa:
    const withGeom = features.filter(f => !!f.geometry);

    const fc = { type: 'FeatureCollection', features: withGeom };

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'application/geo+json; charset=utf-8');
    // CORS abierto para que Goodbarber pueda leerlo
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send(JSON.stringify(fc));
  } catch (e) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(500).json({ error: String(e) });
  }
}

