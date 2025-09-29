// api/aemet.js
const { XMLParser } = require("fast-xml-parser");

const API_BASE = "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp";

function toFloat(x){ const n = parseFloat(x); return Number.isFinite(n) ? n : null; }

// Convierte string CAP <polygon> "lat lon lat lon ..." -> anillo GeoJSON [ [lon,lat], ... ]
function parsePolygonString(polyStr){
  const tokens = String(polyStr).trim().split(/[\s]+/);
  const coords = [];
  for (let i=0; i<tokens.length; i+=2){
    const lat = toFloat(tokens[i]);
    const lon = toFloat(tokens[i+1]);
    if (lat==null || lon==null) continue;
    coords.push([lon, lat]);
  }
  if (coords.length && (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1])) {
    coords.push(coords[0]);
  }
  return coords.length >= 4 ? coords : null;
}

function capToGeoJSON(capXmlObj){
  const alerts = Array.isArray(capXmlObj.alert) ? capXmlObj.alert : [capXmlObj.alert];
  const features = [];

  for (const alert of alerts){
    const { identifier, sender, sent, status, msgType, scope, info } = alert || {};
    const infos = Array.isArray(info) ? info : (info ? [info] : []);
    for (const inf of infos){
      const {
        event, headline, description, instruction,
        urgency, severity, certainty, effective, onset, expires, area
      } = inf || {};

      const areas = Array.isArray(area) ? area : (area ? [area] : []);
      for (const a of areas){
        const polys = a?.polygon ? (Array.isArray(a.polygon) ? a.polygon : [a.polygon]) : [];
        for (const pStr of polys){
          const ring = parsePolygonString(pStr);
          if (!ring) continue;
          features.push({
            type: "Feature",
            properties: {
              identifier, sender, sent, status, msgType, scope,
              event, headline, description, instruction,
              urgency, severity, certainty,
              effective, onset, expires,
              areaDesc: a?.areaDesc || null,
              nivel: (severity || "").toLowerCase()
            },
            geometry: { type: "Polygon", coordinates: [ring] }
          });
        }
      }
    }
  }
  return { type: "FeatureCollection", features };
}

module.exports = async (req, res) => {
  try {
    const KEY = process.env.AEMET_API_KEY;
    if (!KEY) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(500).json({ error: "Falta AEMET_API_KEY en variables de entorno" });
    }

    // Paso 1: pide a AEMET el descriptor con el enlace real
    const r1 = await fetch(`${API_BASE}?api_key=${encodeURIComponent(KEY)}`, { cache: "no-store" });
    if (!r1.ok) throw new Error(`AEMET step1 HTTP ${r1.status}`);
    const j = await r1.json();
    if (!j?.datos) throw new Error(`Respuesta AEMET sin 'datos'`);

    // Paso 2: descarga el CAP (XML)
    const r2 = await fetch(j.datos, { cache: "no-store" });
    if (!r2.ok) throw new Error(`AEMET step2 HTTP ${r2.status}`);
    const xml = await r2.text();

    // Paso 3: CAP -> GeoJSON
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const cap = parser.parse(xml);
    const geojson = capToGeoJSON(cap);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=120");
    res.setHeader("Content-Type", "application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geojson));
  } catch (e) {
    console.error(e);
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(500).json({ error: "No se pudieron obtener los avisos de AEMET (CAP→GeoJSON)" });
  }
};
