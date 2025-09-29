// api/aemet.js
// Requiere Node 18+ (fetch nativo) y "fast-xml-parser" en package.json
const { XMLParser } = require("fast-xml-parser");

const API_BASE = "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp";

// ---------- Utilidades ----------
const toNum = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

function parsePolygonString(polyStr) {
  const t = String(polyStr || "").trim();
  if (!t) return null;
  const coords = [];
  if (t.includes(",")) {
    // "lat,lon lat,lon ; lat,lon"
    const pairs = t.split(/[;\s]+/).filter(Boolean);
    for (const pair of pairs) {
      const [latStr, lonStr] = pair.split(",");
      const lat = toNum(latStr), lon = toNum(lonStr);
      if (lat != null && lon != null) coords.push([lon, lat]); // GeoJSON [lon,lat]
    }
  } else {
    // "lat lon lat lon ..."
    const vals = t.split(/[;\s]+/).map(toNum).filter(v => v != null);
    for (let i = 0; i + 1 < vals.length; i += 2) coords.push([vals[i + 1], vals[i]]);
  }
  if (coords.length && (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length >= 4 ? coords : null;
}

function parseCircleString(circleStr) {
  // CAP <circle>: "lat,lon radiusKm" o "lat lon radiusKm"
  const t = String(circleStr || "").trim();
  if (!t) return null;
  const m = t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = toNum(m[1]), lon = toNum(m[2]), rkm = toNum(m[3]);
  if (lat == null || lon == null || rkm == null) return null;

  const R = 6371.0;              // km
  const rad = rkm / R;
  const lat0 = lat * Math.PI / 180, lon0 = lon * Math.PI / 180;
  const steps = 64, ring = [];
  for (let i = 0; i <= steps; i++) {
    const brng = (2 * Math.PI * i) / steps;
    const latp = Math.asin(Math.sin(lat0) * Math.cos(rad) + Math.cos(lat0) * Math.sin(rad) * Math.cos(brng));
    const lonp = lon0 + Math.atan2(Math.sin(brng) * Math.sin(rad) * Math.cos(lat0), Math.cos(rad) - Math.sin(lat0) * Math.sin(latp));
    ring.push([lonp * 180 / Math.PI, latp * 180 / Math.PI]);
  }
  return ring;
}

function mapSeverity(info) {
  // Usa CAP severity; si hay awareness_level lo mapea
  let sev = info?.severity || "";
  const ecs = Array.isArray(info?.eventCode) ? info.eventCode : (info?.eventCode ? [info.eventCode] : []);
  for (const c of ecs) {
    const name = (c?.valueName || "").toLowerCase();
    const val = (c?.value || "").toLowerCase();
    if (name.includes("awareness_level")) {
      if (/red|rojo|extreme|severe/.test(val)) sev ||= "Severe";
      if (/orange|naranja|moderate/.test(val)) sev ||= "Moderate";
      if (/yellow|amarillo|minor/.test(val)) sev ||= "Minor";
    }
  }
  return sev;
}

function capToGeoJSON(cap) {
  const alerts = Array.isArray(cap.alert) ? cap.alert : (cap.alert ? [cap.alert] : []);
  const features = [];
  for (const alert of alerts) {
    const base = (({ identifier, sender, sent, status, msgType, scope }) => ({ identifier, sender, sent, status, msgType, scope }))(alert || {});
    const infos = Array.isArray(alert?.info) ? alert.info : (alert?.info ? [alert.info] : []);
    for (const info of infos) {
      const { event, headline, description, instruction, urgency, certainty, effective, onset, expires } = info || {};
      const severity = mapSeverity(info);
      const areas = Array.isArray(info?.area) ? info.area : (info?.area ? [info.area] : []);
      for (const a of areas) {
        const props = { ...base, event, headline, description, instruction, urgency, severity, certainty, effective, onset, expires, areaDesc: a?.areaDesc || null };

        const polys = a?.polygon ? (Array.isArray(a.polygon) ? a.polygon : [a.polygon]) : [];
        for (const pStr of polys) {
          const ring = parsePolygonString(pStr);
          if (ring) features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
        }

        const circles = a?.circle ? (Array.isArray(a.circle) ? a.circle : [a.circle]) : [];
        for (const cStr of circles) {
          const ring = parseCircleString(cStr);
          if (ring) features.push({ type: "Feature", properties: props, geometry: { type: "Polygon", coordinates: [ring] } });
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const url = new URL(req.url, "http://localhost");
  const debug = url.searchParams.has("debug");

  try {
    const KEY = process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error: "Falta AEMET_API_KEY" });

    const step1Url = `${API_BASE}?api_key=${encodeURIComponent(KEY)}`;
    const r1 = await fetch(step1Url, { cache: "no-store" });
    const t1 = await r1.text();
    let j;
    try { j = JSON.parse(t1); } catch {
      return res.status(502).json({ error: "Descriptor AEMET no es JSON", step1_status: r1.status, step1_body: t1.slice(0, 500) });
    }
    if (!r1.ok) return res.status(r1.status).json({ error: "AEMET step1 fallo", step1_status: r1.status, step1_json: j });

    if (!j?.datos) return res.status(502).json({ error: "Respuesta AEMET sin 'datos'", step1_status: r1.status, step1_json: j });

    const r2 = await fetch(j.datos, { cache: "no-store" });
    const t2 = await r2.text();
    if (!r2.ok) return res.status(r2.status).json({ error: "AEMET step2 fallo", step2_status: r2.status, step2_body: t2.slice(0, 500) });

    if (debug) {
      // Devuelve información de diagnóstico sin parsear todo
      return res.status(200).json({
        debug: true,
        step1_status: r1.status,
        step2_status: r2.status,
        step2_head: t2.slice(0, 300)
      });
    }

    // Puede venir HTML/JSON de error; detecta y reporta
    if (/^\s*</.test(t2) === false && /^\s*\{/.test(t2)) {
      return res.status(502).json({ error: "AEMET devolvió JSON en step2 (esperado XML CAP)", step2_body: t2.slice(0, 500) });
    }

    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    let cap;
    try { cap = parser.parse(t2); }
    catch (e) { return res.status(502).json({ error: "XML CAP inválido", detail: String(e.message || e), step2_head: t2.slice(0, 300) }); }

    const geojson = capToGeoJSON(cap);
    res.setHeader("Cache-Control", "public, max-age=90");
    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geojson));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "No se pudieron obtener los avisos de AEMET (CAP→GeoJSON)", detail: String(e && e.message || e) });
  }
};

