// Requiere Node 18+ y fast-xml-parser en package.json
const { XMLParser } = require("fast-xml-parser");

// Descriptor "última elaboración" (CAP España)
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

  try {
    // lee la API key desde ?key=... o desde la variable de entorno
    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error: "FALTA_API_KEY", hint: "Pasa ?key=TU_TOKEN o configura AEMET_API_KEY en Vercel" });

    // STEP 1: descriptor JSON
    const step1Url = `${API_BASE}?api_key=${encodeURIComponent(KEY)}`;
    const r1 = await fetch(step1Url, { cache: "no-store" });
    const t1 = await r1.text();
    let j; try { j = JSON.parse(t1); } catch {
      return res.status(502).json({ error: "STEP1_NO_JSON", status: r1.status, body: t1.slice(0, 300) });
    }
    if (!r1.ok) return res.status(r1.status).json({ error: "STEP1_HTTP", status: r1.status, json: j });
    if (!j?.datos) return res.status(502).json({ error: "STEP1_SIN_DATOS", json: j });

    // STEP 2: descarga XML CAP
    const r2 = await fetch(j.datos, { cache: "no-store" });
    const t2 = await r2.text();
    if (!r2.ok) return res.status(r2.status).json({ error: "STEP2_HTTP", status: r2.status, body: t2.slice(0, 300) });
    // si viniese JSON/HTML inesperado:
    if (/^\s*\{/.test(t2)) return res.status(502).json({ error: "STEP2_JSON_INESPERADO", head: t2.slice(0, 300) });

    // Parseo XML → CAP
    let cap;
    try {
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
      cap = parser.parse(t2);
    } catch (e) {
      return res.status(502).json({ error: "XML_INVALIDO", detail: String(e.message || e), head: t2.slice(0, 300) });
    }

    // CAP → GeoJSON
    const geojson = capToGeoJSON(cap);
    res.setHeader("Cache-Control", "public, max-age=90");
    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geojson));
  } catch (e) {
    return res.status(500).json({ error: "FALLO_DESCONOCIDO", detail: String(e && e.message || e) });
  }
};

