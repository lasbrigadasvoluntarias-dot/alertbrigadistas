// Requiere Node 18+ y fast-xml-parser en package.json
const { XMLParser } = require("fast-xml-parser");

const API_BASE = "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp";

// ----- helpers de geometría CAP -----
const toNum = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

function parsePolygonString(polyStr) {
  const t = String(polyStr || "").trim(); if (!t) return null;
  const coords = [];
  if (t.includes(",")) {
    const pairs = t.split(/[;\s]+/).filter(Boolean);
    for (const pair of pairs) {
      const [latStr, lonStr] = pair.split(",");
      const lat = toNum(latStr), lon = toNum(lonStr);
      if (lat != null && lon != null) coords.push([lon, lat]);
    }
  } else {
    const vals = t.split(/[;\s]+/).map(toNum).filter(v => v != null);
    for (let i = 0; i + 1 < vals.length; i += 2) coords.push([vals[i + 1], vals[i]]);
  }
  if (coords.length && (coords[0][0] !== coords.at(-1)[0] || coords[0][1] !== coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length >= 4 ? coords : null;
}

function parseCircleString(circleStr) {
  const t = String(circleStr || "").trim(); if (!t) return null;
  const m = t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat = toNum(m[1]), lon = toNum(m[2]), rkm = toNum(m[3]); if (lat==null||lon==null||rkm==null) return null;
  const R=6371, rad=rkm/R, lat0=lat*Math.PI/180, lon0=lon*Math.PI/180, steps=64, ring=[];
  for (let i=0;i<=steps;i++){
    const brng=(2*Math.PI*i)/steps;
    const latp=Math.asin(Math.sin(lat0)*Math.cos(rad)+Math.cos(lat0)*Math.sin(rad)*Math.cos(brng));
    const lonp=lon0+Math.atan2(Math.sin(brng)*Math.sin(rad)*Math.cos(lat0),Math.cos(rad)-Math.sin(lat0)*Math.sin(latp));
    ring.push([lonp*180/Math.PI, latp*180/Math.PI]);
  }
  return ring;
}

function mapSeverity(info){
  let sev = info?.severity || "";
  const ecs = Array.isArray(info?.eventCode) ? info.eventCode : (info?.eventCode ? [info.eventCode] : []);
  for (const c of ecs){
    const name=(c?.valueName||"").toLowerCase(), val=(c?.value||"").toLowerCase();
    if (name.includes("awareness_level")){
      if (/red|rojo|extreme|severe/.test(val)) sev ||= "Severe";
      if (/orange|naranja|moderate/.test(val)) sev ||= "Moderate";
      if (/yellow|amarillo|minor/.test(val)) sev ||= "Minor";
    }
  }
  return sev;
}

function capToGeoJSON(cap){
  const alerts = Array.isArray(cap.alert) ? cap.alert : (cap.alert ? [cap.alert] : []);
  const features=[];
  for (const alert of alerts){
    const base=(( {identifier,sender,sent,status,msgType,scope} )=>({identifier,sender,sent,status,msgType,scope}))(alert||{});
    const infos = Array.isArray(alert?.info) ? alert.info : (alert?.info ? [alert.info] : []);
    for (const info of infos){
      const { event, headline, description, instruction, urgency, certainty, effective, onset, expires } = info || {};
      const severity = mapSeverity(info);
      const areas = Array.isArray(info?.area) ? info.area : (info?.area ? [info.area] : []);
      for (const a of areas){
        const props = { ...base, event, headline, description, instruction, urgency, severity, certainty, effective, onset, expires, areaDesc: a?.areaDesc || null };
        const polys = a?.polygon ? (Array.isArray(a.polygon) ? a.polygon : [a.polygon]) : [];
        for (const pStr of polys){ const ring = parsePolygonString(pStr); if (ring) features.push({ type:"Feature", properties:props, geometry:{ type:"Polygon", coordinates:[ring] } }); }
        const circles = a?.circle ? (Array.isArray(a.circle) ? a.circle : [a.circle]) : [];
        for (const cStr of circles){ const ring = parseCircleString(cStr); if (ring) features.push({ type:"Feature", properties:props, geometry:{ type:"Polygon", coordinates:[ring] } }); }
      }
    }
  }
  return { type:"FeatureCollection", features };
}

// ----- handler con diagnóstico detallado -----
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error: "FALTA_API_KEY" });

    // STEP 1: descriptor JSON
    let r1, t1, j;
    try {
      r1 = await fetch(`${API_BASE}?api_key=${encodeURIComponent(KEY)}`, {
        cache: "no-store",
        headers: {
          "Accept": "application/json",
          "User-Agent": "alertbrigadistas/1.0 (+contacto)"
        }
      });
      t1 = await r1.text();
    } catch (e) {
      return res.status(502).json({ error: "STEP1_FETCH_FAILED", code: e.cause?.code || e.code || null, message: String(e.message || e) });
    }
    try { j = JSON.parse(t1); } catch {
      return res.status(502).json({ error: "STEP1_NO_JSON", status: r1.status, body: t1.slice(0,300) });
    }
    if (!r1.ok) return res.status(r1.status).json({ error: "STEP1_HTTP", status: r1.status, json: j });
    if (!j?.datos) return res.status(502).json({ error: "STEP1_SIN_DATOS", json: j });

    // STEP 2: descarga del CAP (con reintento añadiendo api_key a la URL de datos)
    const getCap = async () => {
      try {
        const r = await fetch(j.datos, { cache:"no-store", headers:{ "Accept":"application/xml,text/xml;q=0.9,*/*;q=0.8", "User-Agent":"alertbrigadistas/1.0" } });
        const t = await r.text();
        return { r, t, triedSuffix:false };
      } catch (e) {
        return { r:null, t:null, err:e, triedSuffix:false };
      }
    };
    let { r: r2, t: t2, err, triedSuffix } = await getCap();
    if (!r2 || !r2.ok) {
      // reintento con ?api_key=
      const sep = j.datos.includes("?") ? "&" : "?";
      try {
        r2 = await fetch(j.datos + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", headers:{ "Accept":"application/xml,text/xml;q=0.9,*/*;q=0.8", "User-Agent":"alertbrigadistas/1.0" } });
        t2 = await r2.text();
        triedSuffix = true;
      } catch (e2) {
        return res.status(502).json({
          error: "STEP2_FETCH_FAILED",
          first_error: err ? (err.cause?.code || err.code || String(err.message||err)) : null,
          second_error: e2 ? (e2.cause?.code || e2.code || String(e2.message||e2)) : null
        });
      }
    }
    if (!r2.ok) return res.status(r2.status).json({ error: "STEP2_HTTP", status: r2.status, withKeySuffix: triedSuffix, head: (t2||"").slice(0,300) });
    if (/^\s*\{/.test(t2||"")) return res.status(502).json({ error: "STEP2_JSON_INESPERADO", head: t2.slice(0,300) });

    // Parseo XML → GeoJSON
    let cap;
    try {
      const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"" });
      cap = parser.parse(t2);
    } catch (e) {
      return res.status(502).json({ error: "XML_INVALIDO", message: String(e.message||e), head: t2.slice(0,300) });
    }

    const geojson = capToGeoJSON(cap);
    res.setHeader("Cache-Control","public, max-age=90");
    res.setHeader("Content-Type","application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geojson));
  } catch (e) {
    return res.status(500).json({ error: "FALLO_DESCONOCIDO", detail: String(e && e.message || e) });
  }
};

