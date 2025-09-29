// Node 20 (GitHub Actions)
// deps: fast-xml-parser, undici
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";

const AEMET_KEY = process.env.AEMET_API_KEY || "";
const METEOALARM_TOKEN = process.env.METEOALARM_TOKEN || ""; // <-- añade este secret
const agent = new Agent({ connect: { family: 4, timeout: 15000 } });

const UA_JSON = { "User-Agent": "alertbrigadistas/1.0 (+github actions)", "Accept": "application/json" };
const UA_XML  = { "User-Agent": "alertbrigadistas/1.0 (+github actions)", "Accept": "application/xml, text/xml" };

// --- AEMET (respaldo) ---
const AEMET_DESC_URLS = [
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp",
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion?area=esp"
];

// ---------- Utilidades CAP→GeoJSON (por si usamos AEMET como respaldo) ----------
const toNum = (x)=>{ const n=parseFloat(x); return Number.isFinite(n)?n:null; };
function parsePolygonString(polyStr){
  const t=String(polyStr||"").trim(); if(!t) return null;
  const coords=[];
  if(t.includes(",")){ // "lat,lon lat,lon ..."
    const pairs=t.split(/[;\s]+/).filter(Boolean);
    for(const pair of pairs){ const [latStr,lonStr]=pair.split(","); const lat=toNum(latStr),lon=toNum(lonStr); if(lat!=null&&lon!=null) coords.push([lon,lat]); }
  } else { // "lat lon lat lon ..."
    const vals=t.split(/[;\s]+/).map(toNum).filter(v=>v!=null);
    for(let i=0;i+1<vals.length;i+=2) coords.push([vals[i+1], vals[i]]);
  }
  if(coords.length && (coords[0][0]!==coords.at(-1)[0] || coords[0][1]!==coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length>=4 ? coords : null;
}
function parseCircleString(circleStr){
  const t=String(circleStr||"").trim(); if(!t) return null;
  const m=t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if(!m) return null;
  const lat=toNum(m[1]), lon=toNum(m[2]), rkm=toNum(m[3]); if(lat==null||lon==null||rkm==null) return null;
  const R=6371, rad=rkm/R, lat0=lat*Math.PI/180, lon0=lon*Math.PI/180, steps=64, ring=[];
  for(let i=0;i<=steps;i++){
    const brng=(2*Math.PI*i)/steps;
    const latp=Math.asin(Math.sin(lat0)*cos(rad)+Math.cos(lat0)*Math.sin(rad)*Math.cos(brng));
    const lonp=lon0+Math.atan2(Math.sin(brng)*Math.sin(rad)*Math.cos(lat0),Math.cos(rad)-Math.sin(lat0)*Math.sin(latp));
    function cos(x){return Math.cos(x)}
    ring.push([lonp*180/Math.PI, latp*180/Math.PI]);
  }
  return ring;
}
function mapSeverityFromEventCode(info){
  let sev=info?.severity||"";
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
      const severity = mapSeverityFromEventCode(info) || info?.severity || "";
      const areas = Array.isArray(info?.area) ? info.area : (info?.area ? [info.area] : []);
      for (const a of areas){
        const props = { ...base, event, headline, description, instruction, urgency, severity, certainty, effective, onset, expires, areaDesc: a?.areaDesc || null };
        const polys = a?.polygon ? (Array.isArray(a.polygon) ? a.polygon : [a.polygon]) : [];
        for (const pStr of polys){ const ring=parsePolygonString(pStr); if (ring) features.push({ type:"Feature", properties:props, geometry:{ type:"Polygon", coordinates:[ring] } }); }
        const circles = a?.circle ? (Array.isArray(a.circle) ? a.circle : [a.circle]) : [];
        for (const cStr of circles){ const ring=parseCircleString(cStr); if (ring) features.push({ type:"Feature", properties:props, geometry:{ type:"Polygon", coordinates:[ring] } }); }
      }
    }
  }
  return { type:"FeatureCollection", features };
}

// ---------- helpers ----------
async function fetchText(url, headers){
  const r = await fetch(url, { dispatcher: agent, headers });
  const t = await r.text();
  return { ok:r.ok, status:r.status, text:t, url };
}

// --- 1) Meteoalarm EDR (GeoJSON con geometría; requiere token) ---
async function getMeteoalarmGeoJSON(){
  if (!METEOALARM_TOKEN) return null;

  // Endpoint “locations/ES” (GeoJSON). Se puede pasar Authorization: Bearer <token> o ?token=<token>.
  // Custom params útiles (documentados): active (intervalo), language, awareness_type, awareness_level, page. :contentReference[oaicite:1]{index=1}
  const base = "https://api.meteoalarm.org/edr/v1/collections/warnings/locations/ES";
  const q = "?f=geojson&active&language=es-ES"; // ‘active’ sin valor = activo ahora; idioma ES (si soporta)
  // 1) Con Authorization header
  try{
    const r1 = await fetch(base + q, {
      dispatcher: agent,
      headers: { "Authorization": `Bearer ${METEOALARM_TOKEN}`, "Accept": "application/geo+json, application/json" }
    });
    if (r1.ok) return await r1.text();
  }catch{}

  // 2) Con query ?token=
  try{
    const sep = q ? "&" : "?";
    const r2 = await fetch(base + q + `${sep}token=${encodeURIComponent(METEOALARM_TOKEN)}`, {
      dispatcher: agent,
      headers: { "Accept": "application/geo+json, application/json" }
    });
    if (r2.ok) return await r2.text();
  }catch{}

  return null;
}

// --- 2) AEMET CAP (respaldo a GeoJSON) ---
async function getAemetCAPXml(){
  if (!AEMET_KEY) return null;
  for (const base of AEMET_DESC_URLS){
    // a) api_key en cabecera
    try{
      let {ok,text} = await fetchText(base, { ...UA_JSON, "api_key": AEMET_KEY });
      if (ok){
        try{
          const j = JSON.parse(text);
          if (j?.datos){
            let cap = await fetchText(j.datos, UA_XML);
            if (!cap.ok || !cap.text.trim().startsWith("<")){
              const sep = j.datos.includes("?") ? "&" : "?";
              cap = await fetchText(j.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, UA_XML);
            }
            if (cap.ok && cap.text.trim().startsWith("<")) return cap.text;
          }
        }catch{}
      }
    }catch{}
    // b) api_key en query
    try{
      const sep = base.includes("?") ? "&" : "?";
      let {ok,text} = await fetchText(base + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, UA_JSON);
      if (ok){
        try{
          const j = JSON.parse(text);
          if (j?.datos){
            let cap = await fetchText(j.datos, UA_XML);
            if (!cap.ok || !cap.text.trim().startsWith("<")){
              const sep2 = j.datos.includes("?") ? "&" : "?";
              cap = await fetchText(j.datos + `${sep2}api_key=${encodeURIComponent(AEMET_KEY)}`, UA_XML);
            }
            if (cap.ok && cap.text.trim().startsWith("<")) return cap.text;
          }
        }catch{}
      }
    }catch{}
  }
  return null;
}

// --- MAIN ---
async function main(){
  const outDir  = fileURLToPath(new URL("../dist/", import.meta.url));
  const outFile = outDir + "avisos.geojson";
  await mkdir(outDir, { recursive: true });

  let published = false;

  // 1) Meteoalarm EDR
  try{
    const gj = await getMeteoalarmGeoJSON();
    if (gj){
      // Debe ser FeatureCollection con features[]. El portal indica GeoJSON, con geometrías “bounding boxes”. :contentReference[oaicite:2]{index=2}
      const parsed = JSON.parse(gj);
      if (parsed && (parsed.type === "FeatureCollection") && Array.isArray(parsed.features) && parsed.features.length){
        await writeFile(outFile, JSON.stringify(parsed));
        console.log("EDR: publicado con", parsed.features.length, "features");
        published = true;
      } else {
        console.warn("EDR: GeoJSON sin features; probamos AEMET");
      }
    } else {
      console.warn("EDR: sin respuesta válida; probamos AEMET");
    }
  }catch(e){
    console.warn("EDR: error", e?.message||e);
  }

  // 2) Respaldo AEMET CAP → GeoJSON
  if (!published){
    try{
      const capXml = await getAemetCAPXml();
      if (capXml){
        const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });
        const cap = parser.parse(capXml);
        const g = capToGeoJSON(cap);
        if ((g.features||[]).length){
          await writeFile(outFile, JSON.stringify(g));
          console.log("AEMET: publicado con", g.features.length, "features");
          published = true;
        } else {
          console.warn("AEMET: CAP sin geometría utilizable");
        }
      }
    }catch(e){ console.warn("AEMET error", e?.message||e); }
  }

  // 3) Si nada funcionó: conservar último o vacío
  if (!published){
    try {
      const prev = await readFile(outFile, "utf-8");
      await writeFile(outFile, prev);
      console.warn("Avisos: sin fuente válida; se conserva el último fichero");
    } catch {
      await writeFile(outFile, JSON.stringify({ type:"FeatureCollection", features:[] }));
      console.warn("Avisos: sin fuente y sin anterior; publicado vacío");
    }
  }
}

main().catch(e=>{ console.error(e); process.exit(0); });

