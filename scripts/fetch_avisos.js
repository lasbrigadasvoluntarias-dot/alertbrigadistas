// Node 20 (Actions) | deps: fast-xml-parser, undici
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";

const AEMET_KEY = process.env.AEMET_API_KEY;
if (!AEMET_KEY) { console.error("Falta AEMET_API_KEY"); process.exit(1); }

const DESCRIPTORS = [
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp",
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion?area=esp"
];

const agent = new Agent({ connect: { family: 4, timeout: 15000 } }); // fuerza IPv4
const UA = { "User-Agent": "alertbrigadistas/1.0 (+github actions)", "Accept": "application/json" };

const toNum = (x)=>{ const n=parseFloat(x); return Number.isFinite(n)?n:null; };
function parsePolygonString(polyStr){
  const t=String(polyStr||"").trim(); if(!t)return null; const coords=[];
  if(t.includes(",")){ const pairs=t.split(/[;\s]+/).filter(Boolean);
    for(const pair of pairs){ const [latStr,lonStr]=pair.split(","); const lat=toNum(latStr),lon=toNum(lonStr); if(lat!=null&&lon!=null) coords.push([lon,lat]); }
  } else { const vals=t.split(/[;\s]+/).map(toNum).filter(v=>v!=null); for(let i=0;i+1<vals.length;i+=2) coords.push([vals[i+1],vals[i]]); }
  if(coords.length&&(coords[0][0]!==coords.at(-1)[0]||coords[0][1]!==coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length>=4?coords:null;
}
function parseCircleString(circleStr){
  const t=String(circleStr||"").trim(); if(!t)return null;
  const m=t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/); if(!m) return null;
  const lat=toNum(m[1]), lon=toNum(m[2]), rkm=toNum(m[3]); if(lat==null||lon==null||rkm==null) return null;
  const R=6371, rad=rkm/R, lat0=lat*Math.PI/180, lon0=lon*Math.PI/180, steps=64, ring=[];
  for(let i=0;i<=steps;i++){ const brng=(2*Math.PI*i)/steps;
    const latp=Math.asin(Math.sin(lat0)*Math.cos(rad)+Math.cos(lat0)*Math.sin(rad)*Math.cos(brng));
    const lonp=lon0+Math.atan2(Math.sin(brng)*Math.sin(rad)*Math.cos(lat0),Math.cos(rad)-Math.sin(lat0)*Math.sin(latp));
    ring.push([lonp*180/Math.PI, latp*180/Math.PI]);
  }
  return ring;
}
function mapSeverity(info){
  let sev=info?.severity||""; const ecs=Array.isArray(info?.eventCode)?info.eventCode:(info?.eventCode?[info.eventCode]:[]);
  for(const c of ecs){ const name=(c?.valueName||"").toLowerCase(), val=(c?.value||"").toLowerCase();
    if(name.includes("awareness_level")){
      if(/red|rojo|extreme|severe/.test(val)) sev||="Severe";
      if(/orange|naranja|moderate/.test(val)) sev||="Moderate";
      if(/yellow|amarillo|minor/.test(val)) sev||="Minor";
    }
  } return sev;
}
function capToGeoJSON(cap){
  const alerts=Array.isArray(cap.alert)?cap.alert:(cap.alert?[cap.alert]:[]);
  const features=[];
  for(const alert of alerts){
    const base=(( {identifier,sender,sent,status,msgType,scope} )=>({identifier,sender,sent,status,msgType,scope}))(alert||{});
    const infos=Array.isArray(alert?.info)?alert.info:(alert?.info?[alert.info]:[]);
    for(const info of infos){
      const {event,headline,description,instruction,urgency,certainty,effective,onset,expires}=info||{};
      const severity=mapSeverity(info);
      const areas=Array.isArray(info?.area)?info.area:(info?.area?[info.area]:[]);
      for(const a of areas){
        const props={...base,event,headline,description,instruction,urgency,severity,certainty,effective,onset,expires,areaDesc:a?.areaDesc||null};
        const polys=a?.polygon?(Array.isArray(a.polygon)?a.polygon:[a.polygon]):[];
        for(const p of polys){ const ring=parsePolygonString(p); if(ring) features.push({type:"Feature",properties:props,geometry:{type:"Polygon",coordinates:[ring]}}); }
        const circles=a?.circle?(Array.isArray(a.circle)?a.circle:[a.circle]):[];
        for(const c of circles){ const ring=parseCircleString(c); if(ring) features.push({type:"Feature",properties:props,geometry:{type:"Polygon",coordinates:[ring]}}); }
      }
    }
  }
  return { type:"FeatureCollection", features };
}

async function fetchDescriptor(){
  const diag=[];
  for (const path of DESCRIPTORS){
    // A) api_key en CABECERA
    try{
      const r = await fetch(path, { dispatcher: agent, headers: { ...UA, "api_key": AEMET_KEY }});
      const txt = await r.text();
      try{ const j = JSON.parse(txt); if (r.ok && j?.datos) return j; diag.push({path,via:"header",status:r.status,head:txt.slice(0,160)}); }
      catch{ diag.push({path,via:"header",status:r.status,head:txt.slice(0,160)}); }
    }catch(e){ diag.push({path,via:"header",fetch:e.cause?.code||e.code||String(e.message||e) }); }
    // B) api_key en QUERY
    try{
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(path + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: UA });
      const txt = await r.text();
      try{ const j = JSON.parse(txt); if (r.ok && j?.datos) return j; diag.push({path,via:"query",status:r.status,head:txt.slice(0,160)}); }
      catch{ diag.push({path,via:"query",status:r.status,head:txt.slice(0,160)}); }
    }catch(e){ diag.push({path,via:"query",fetch:e.cause?.code||e.code||String(e.message||e) }); }
  }
  console.error("STEP1_FALLO_DESCRIPTOR", JSON.stringify(diag, null, 2));
  return null;
}

async function main(){
  const desc = await fetchDescriptor();
  const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });

  if (!desc){
    // fallback: publicar vacío para que Pages no devuelva 404
    await writeFile(outDir + "avisos.geojson", JSON.stringify({ type:"FeatureCollection", features:[] }));
    console.log("Avisos: publicado vacío (no se pudo conectar con AEMET en STEP1)");
    return;
  }

  // DESCARGA CAP (XML) con reintento ?api_key
  const hXML = { "Accept":"application/xml", "User-Agent": UA["User-Agent"] };
  let r = await fetch(desc.datos, { dispatcher: agent, headers: hXML });
  let xml = await r.text();
  if (!r.ok || !xml.trim().startsWith("<")){
    const sep = desc.datos.includes("?") ? "&" : "?";
    r = await fetch(desc.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: hXML });
    xml = await r.text();
  }
  // si aun así no es XML, publicar vacío
  if (!xml.trim().startsWith("<")){
    await writeFile(outDir + "avisos.geojson", JSON.stringify({ type:"FeatureCollection", features:[] }));
    console.warn("Avisos: CAP no es XML, publicado vacío");
    return;
  }

  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"" });
  const cap = parser.parse(xml);
  const geo = capToGeoJSON(cap);
  await writeFile(outDir + "avisos.geojson", JSON.stringify(geo));
  console.log("Escrito dist/avisos.geojson con", geo.features.length, "features");
}

main().catch(e=>{ console.error(e); process.exit(0); /* no romper deploy */ });
