// api/avisos.js
// Node 18+ | deps: fast-xml-parser (undici viene en Node 18)
const { XMLParser } = require("fast-xml-parser");
const { Agent } = require("undici");

// Fuerza IPv4 y timeouts prudentes (evita fallos de red en AEMET)
const agent = new Agent({ connect: { family: 4, timeout: 15_000 } });

const BASE = "https://opendata.aemet.es/opendata/api/avisos_cap";
const DESCRIPTORS = [
  `${BASE}/ultimaelaboracion/area/esp`,
  `${BASE}/ultimaelaboracion?area=esp`
];

const toNum = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

function parsePolygonString(polyStr){
  const t = String(polyStr || "").trim(); if (!t) return null;
  const coords = [];
  if (t.includes(",")) {
    const pairs = t.split(/[;\s]+/).filter(Boolean);
    for (const pair of pairs) { const [latStr,lonStr] = pair.split(","); const lat=toNum(latStr), lon=toNum(lonStr); if (lat!=null && lon!=null) coords.push([lon,lat]); }
  } else {
    const vals = t.split(/[;\s]+/).map(toNum).filter(v=>v!=null);
    for (let i=0;i+1<vals.length;i+=2) coords.push([vals[i+1], vals[i]]);
  }
  if (coords.length && (coords[0][0]!==coords.at(-1)[0] || coords[0][1]!==coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length>=4 ? coords : null;
}

function parseCircleString(circleStr){
  const t = String(circleStr || "").trim(); if (!t) return null;
  const m = t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const lat=toNum(m[1]), lon=toNum(m[2]), rkm=toNum(m[3]); if (lat==null||lon==null||rkm==null) return null;
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
    const name=(c?.valueName||"").toLowerCase(); const val=(c?.value||"").toLowerCase();
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
        for (const pStr of polys){ const ring=parsePolygonString(pStr); if (ring) features.push({ type:"Feature", properties:props, geometry:{ type:"Polygon", coordinates:[ring] }}); }
        const circles = a?.circle ? (Array.isArray(a.circle) ? a.circle : [a.circle]) : [];
        for (const cStr of circles){ const ring=parseCircleString(cStr); if (ring) features.push({ type:"Feature", properties:props, geometry:{ type:"Polygon", coordinates:[ring] }}); }
      }
    }
  }
  return { type:"FeatureCollection", features };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error:"FALTA_API_KEY" });

    // STEP1: probar dos rutas, con key en cabecera y en query. Siempre forzando IPv4 via dispatcher.
    let desc=null, diag=[];
    for (const path of DESCRIPTORS){
      try {
        // A) header
        const rH = await fetch(path, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json", "api_key": KEY, "User-Agent":"alertbrigadistas/1.0" }});
        const tH = await rH.text();
        try { const jH = JSON.parse(tH); if (rH.ok && jH?.datos) { desc=jH; break; } else diag.push({path, via:"header", status:rH.status, head:tH.slice(0,160)}); }
        catch { diag.push({path, via:"header", status:rH.status, head:tH.slice(0,160)}); }
      } catch (e) { diag.push({path, via:"header", fetch: e.cause?.code || e.code || String(e.message||e)}); }

      try {
        // B) query
        const sep = path.includes("?") ? "&" : "?";
        const rQ = await fetch(path + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json", "User-Agent":"alertbrigadistas/1.0" }});
        const tQ = await rQ.text();
        try { const jQ = JSON.parse(tQ); if (rQ.ok && jQ?.datos) { desc=jQ; break; } else diag.push({path, via:"query", status:rQ.status, head:tQ.slice(0,160)}); }
        catch { diag.push({path, via:"query", status:rQ.status, head:tQ.slice(0,160)}); }
      } catch (e) { diag.push({path, via:"query", fetch: e.cause?.code || e.code || String(e.message||e)}); }
    }
    if (!desc) return res.status(502).json({ error:"STEP1_FALLO_DESCRIPTOR", tries: diag });

    // STEP2: descarga del CAP (XML). Reintenta añadiendo api_key si hace falta.
    const fetchCap = async (u) => {
      try {
        const r = await fetch(u, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/xml", "User-Agent":"alertbrigadistas/1.0" }});
        const t = await r.text();
        if (r.ok && /^\s*</.test(t)) return { ok:true, t, status:r.status, withKey:false };
      } catch (e) {
        // seguimos al reintento con ?api_key
      }
      const sep = u.includes("?") ? "&" : "?";
      const r2 = await fetch(u + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/xml", "User-Agent":"alertbrigadistas/1.0" }});
      const t2 = await r2.text();
      return { ok: r2.ok && /^\s*</.test(t2), t: t2, status:r2.status, withKey:true };
    };

    const capRes = await fetchCap(desc.datos);
    if (!capRes.ok) return res.status(502).json({ error:"STEP2_FALLO_CAP", status: capRes.status, withKeySuffix: capRes.withKey, head: String(capRes.t).slice(0,200) });

    // XML → GeoJSON
    let capObj;
    try {
      const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"" });
      capObj = parser.parse(capRes.t);
    } catch (e) { return res.status(502).json({ error:"XML_INVALIDO", message:String(e?.message||e) }); }

    const geo = capToGeoJSON(capObj);
    res.setHeader("Cache-Control","public, max-age=90");
    res.setHeader("Content-Type","application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geo));
  } catch (e) {
    return res.status(500).json({ error:"FALLO_DESCONOCIDO", detail: String(e?.message||e) });
  }
};

