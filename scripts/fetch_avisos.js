// Node 20 en GitHub Actions
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

const AEMET_KEY = process.env.AEMET_API_KEY;
if (!AEMET_KEY) { console.error("Falta AEMET_API_KEY"); process.exit(1); }

const DESCRIPTORS = [
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp",
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion?area=esp"
];

const toNum = (x)=>{ const n=parseFloat(x); return Number.isFinite(n)?n:null; };
function parsePolygonString(polyStr){
  const t = String(polyStr||"").trim(); if (!t) return null;
  const coords=[];
  if (t.includes(",")){
    const pairs=t.split(/[;\s]+/).filter(Boolean);
    for (const pair of pairs){ const [latStr,lonStr]=pair.split(","); const lat=toNum(latStr), lon=toNum(lonStr); if (lat!=null&&lon!=null) coords.push([lon,lat]); }
  } else {
    const vals=t.split(/[;\s]+/).map(toNum).filter(v=>v!=null);
    for (let i=0;i+1<vals.length;i+=2) coords.push([vals[i+1], vals[i]]);
  }
  if (coords.length && (coords[0][0]!==coords.at(-1)[0] || coords[0][1]!==coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length>=4 ? coords : null;
}
function parseCircleString(circleStr){
  const t=String(circleStr||"").trim(); if (!t) return null;
  const m=t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
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
  const ecs = Array.isArray(info?.eventCode) ? info.eventCode : (info?.eventCode ? [info?.eventCode] : []);
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
        for (const p of polys){ const ring=parsePolygonString(p); if (ring) features.push({type:"Feature", properties:props, geometry:{type:"Polygon", coordinates:[ring]}}); }
        const circles = a?.circle ? (Array.isArray(a.circle) ? a.circle : [a.circle]) : [];
        for (const c of circles){ const ring=parseCircleString(c); if (ring) features.push({type:"Feature", properties:props, geometry:{type:"Polygon", coordinates:[ring]}}); }
      }
    }
  }
  return { type:"FeatureCollection", features };
}

async function fetchDescriptor(){
  for (const path of DESCRIPTORS){
    // header
    let r = await fetch(path, { headers:{ "Accept":"application/json", "api_key": AEMET_KEY }});
    if (r.ok){ const j=await r.json().catch(()=>null); if (j?.datos) return j; }
    // query
    const sep = path.includes("?") ? "&" : "?";
    r = await fetch(path+`${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { headers:{ "Accept":"application/json" }});
    if (r.ok){ const j=await r.json().catch(()=>null); if (j?.datos) return j; }
  }
  throw new Error("No se pudo obtener descriptor de avisos");
}

async function main(){
  const desc = await fetchDescriptor();
  // descarga CAP (XML) (si hace falta, añade ?api_key)
  let r = await fetch(desc.datos);
  let xml = await r.text();
  if (!r.ok || !xml.trim().startsWith("<")){
    const sep = desc.datos.includes("?") ? "&" : "?";
    r = await fetch(desc.datos+`${sep}api_key=${encodeURIComponent(AEMET_KEY)}`);
    xml = await r.text();
  }
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"" });
  const cap = parser.parse(xml);
  const geo = capToGeoJSON(cap);

  const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });
  await writeFile(outDir + "avisos.geojson", JSON.stringify(geo));
  console.log("Escrito dist/avisos.geojson con", geo.features.length, "features");
}
main().catch(e=>{ console.error(e); process.exit(1); });
