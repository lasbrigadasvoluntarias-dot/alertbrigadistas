// api/aemet.js
// Requisitos: Node >=18 (fetch nativo) y fast-xml-parser en package.json
const { XMLParser } = require("fast-xml-parser");

const API_BASE = "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp";

// Utilidades de parseo
function toNum(x) { const n = parseFloat(x); return Number.isFinite(n) ? n : null; }

function parsePolygonString(polyStr) {
  const t = String(polyStr || "").trim();
  if (!t) return null;

  const coords = [];
  // Caso 1: "lat,lon lat,lon ; lat,lon" (común en CAP)
  if (t.includes(",")) {
    // Divide por espacios o ; en bloques "lat,lon"
    const pairs = t.split(/[;\s]+/).filter(Boolean);
    for (const pair of pairs) {
      const [latStr, lonStr] = pair.split(",");
      const lat = toNum(latStr), lon = toNum(lonStr);
      if (lat != null && lon != null) coords.push([lon, lat]); // GeoJSON => [lon,lat]
    }
  } else {
    // Caso 2: "lat lon lat lon ..." (menos común)
    const vals = t.split(/[;\s]+/).map(toNum).filter(v => v != null);
    for (let i = 0; i + 1 < vals.length; i += 2) {
      const lat = vals[i], lon = vals[i + 1];
      coords.push([lon, lat]);
    }
  }

  // Cierra anillo
  if (coords.length && (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1])) {
    coords.push(coords[0]);
  }
  return coords.length >= 4 ? coords : null;
}

function parseCircleString(circleStr) {
  // CAP <circle>: "lat,lon radiusKm" (a veces "lat lon radiusKm")
  const t = String(circleStr || "").trim();
  if (!t) return null;
  const m = t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = toNum(m[1]), lon = toNum(m[2]), rkm = toNum(m[3]);
  if (lat == null || lon == null || rkm == null) return null;

  // Aproxima el círculo como polígono de 64 puntos
  const R = 6371.0;                  // radio terrestre (km)
  const rad = rkm / R;               // radio angular
  const lat0 = lat * Math.PI / 180;
  const lon0 = lon * Math.PI / 180;
  const steps = 64;
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const brng = (2 * Math.PI * i) / steps;
    const latp = Math.asin(Math.sin(lat0) * Math.cos(rad) + Math.cos(lat0) * Math.sin(rad) * Math.cos(brng));
    const lonp = lon0 + Math.atan2(Math.sin(brng) * Math.sin(rad) * Math.cos(lat0), Math.cos(rad) - Math.sin(lat0) * Math.sin(latp));
    ring.push([lonp * 180 / Math.PI, latp * 180 / Math.PI]);
  }
  return ring;
}

function mapSeverity(info) {
  // Preferimos 'severity' CAP; si viene 'eventCode' awareness_level lo usamos de apoyo
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
    const { identifier, sender, sent, status, msgType, scope } = alert || {};
    const infos = Array.isArray(alert?.info) ? alert.info : (alert?.info ? [alert.info] : []);
    for (const info of infos) {
      const { event, headline, description, instruction, urgency, certainty, effective, onset, expires } = info || {};
      const severity = mapSeverity(info);
      const areas = Array.isArray(info?.area) ? info.area : (info?.area ? [info.area] : []);
      for (const a of areas) {
        // Polígonos
        const polys = a?.polygon ? (Array.isArray(a.polygon) ? a.polygon : [a.polygon]) : [];
        for (const pStr of polys) {
          const ring = parsePolygonString(pStr);
          if (ring) {
            features.push({
              type: "Feature",
              properties: {
                identifier, sender, sent, status, msgType, scope,
                event, headline, description, instruction,
                urgency, severity, certainty, effective, onset, expires,
                areaDesc: a?.areaDesc || null
              },
              geometry: { type: "Polygon", coordinates: [ring] }
            });
          }
        }
        // Círculos
        const circles = a?.circle ? (Array.isArray(a.circle) ? a.circle : [a.circle]) : [];
        for (const cStr of circles) {
          const ring = parseCircleString(cStr);
          if (ring) {
            features.push({
              type: "Feature",
              properties: {
                identifier, sender, sent, status, msgType, scope,
                event, headline, description, instruction,
                urgency, severity, certainty, effective, onset, expires,
                areaDesc: a?.areaDesc || null
              },
              geometry: { type: "Polygon", coordinates: [ring] }
            });
          }
        }
      }
    }
  }

  return { type: "FeatureCollection", features };
}

module.exports = async (req, res) => {
  try {
    const KEY = process.env.AEMET_API_KEY;
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!KEY) {
      return res.status(500).json({ error: "Falta AEMET_API_KEY" });
    }

    // Paso 1: descriptor
    const r1 = await fetch(`${API_BASE}?api_key=${encodeURIComponent(KEY)}`, { cache: "no-store" });
    if (!r1.ok) return res.status(502).json({ error: `AEMET step1 HTTP ${r1.status}` });
    const j = await r1.json();
    if (!j?.datos) return res.status(502).json({ error: "Respuesta AEMET sin 'datos'" });

    // Paso 2: XML CAP
    const r2 = await fetch(j.datos, { cache: "no-store" });
    if (!r2.ok) return res.status(502).json({ error: `AEMET step2 HTTP ${r2.status}` });
    const xml = await r2.text();

    // Paso 3: parseo CAP -> GeoJSON
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const cap = parser.parse(xml);
    const geojson = capToGeoJSON(cap);

    res.setHeader("Cache-Control", "public, max-age=90");
    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geojson));
  } catch (e) {
    console.error(e);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: "No se pudieron obtener los avisos de AEMET (CAP→GeoJSON)", detail: String(e && e.message || e) });
  }
};
