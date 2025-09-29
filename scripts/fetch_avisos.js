// Node 20 (GitHub Actions)
// deps: fast-xml-parser, undici
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";
import path from "node:path";

const AEMET_KEY = process.env.AEMET_API_KEY || ""; // respaldo
const agent = new Agent({ connect: { family: 4, timeout: 15000 } });

const UA_ATOM = { "User-Agent":"alertbrigadistas/1.0 (+github actions)", "Accept":"application/atom+xml, application/rss+xml, application/xml, text/xml" };
const UA_JSON = { "User-Agent":"alertbrigadistas/1.0 (+github actions)", "Accept":"application/json" };
const UA_XML  = { "User-Agent":"alertbrigadistas/1.0 (+github actions)", "Accept":"application/xml, text/xml" };

const FEEDS_ES = [
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain",
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-rss-spain"
];

const AEMET_DESC_URLS = [
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp",
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion?area=esp"
];

// ---------- util geo ----------
function toNum(x){ const n=parseFloat(x); return Number.isFinite(n)?n:null; }
function parsePolygonString(polyStr){
  const t=String(polyStr||"").trim(); if(!t) return null;
  const coords=[];
  if(t.includes(",")){ const pairs=t.split(/[;\s]+/).filter(Boolean);
    for(const pair of pairs){ const [latStr,lonStr]=pair.split(","); const lat=toNum(latStr),lon=toNum(lonStr); if(lat!=null&&lon!=null) coords.push([lon,lat]); }
  } else { const vals=t.split(/[;\s]+/).map(toNum).filter(v=>v!=null); for(let i=0;i+1<vals.length;i+=2) coords.push([vals[i+1], vals[i]]); }
  if(coords.length&&(coords[0][0]!==coords.at(-1)[0]||coords[0][1]!==coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length>=4?coords:null;
}
function parseCircleString(circleStr){
  const t=String(circleStr||"").trim(); if(!t) return null;
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
  let sev=info?.severity||"";
  const ecs=Array.isArray(info?.eventCode)?info.eventCode:(info?.eventCode?[info.eventCode]:[]);
  for(const c of ecs){
    const name=(c?.valueName||"").toLowerCase(), val=(c?.value||"").toLowerCase();
    if(name.includes("awareness_level")){
      if(/red|rojo|extreme|severe/.test(val)) sev||="Severe";
      if(/orange|naranja|moderate/.test(val)) sev||="Moderate";
      if(/yellow|amarillo|minor/.test(val)) sev||="Minor";
    }
  } return sev||info?.severity||"";
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
        const props={...base,event,headline,description,instruction,urgency,certainty,severity,effective,onset,expires,areaDesc:a?.areaDesc||null};
        const polys=a?.polygon?(Array.isArray(a.polygon)?a.polygon:[a.polygon]):[];
        for(const p of polys){ const ring=parsePolygonString(p); if(ring) features.push({type:"Feature",properties:props,geometry:{type:"Polygon",coordinates:[ring]}}); }
        const circles=a?.circle?(Array.isArray(a.circle)?a.circle:[a.circle]):[];
        for(const c of circles){ const ring=parseCircleString(c); if(ring) features.push({type:"Feature",properties:props,geometry:{type:"Polygon",coordinates:[ring]}}); }
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

// 1) Leer FEED (Atom/RSS) y extraer entradas con EMMA_ID + metadatos
function parseFeedEntries(xml){
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });
  const obj = parser.parse(xml||"");
  const entries=[];

  // Atom
  if(obj?.feed?.entry){
    const list = Array.isArray(obj.feed.entry)? obj.feed.entry : [obj.feed.entry];
    for(const e of list){
      // cap:* en el feed
      const area = e["cap:areaDesc"] || e.areaDesc || null;
      const event = e["cap:event"] || e.event || null;
      const identifier = e["cap:identifier"] || e.identifier || null;
      const effective = e["cap:effective"] || e.effective || null;
      const onset = e["cap:onset"] || e.onset || null;
      const expires = e["cap:expires"] || e.expires || null;
      const certainty = e["cap:certainty"] || e.certainty || null;
      const urgency = e["cap:urgency"] || e.urgency || null;
      const severity = e["cap:severity"] || e.severity || null;

      // geocode EMMA_ID
      let emma = null;
      const gc = e["cap:geocode"];
      const arr = Array.isArray(gc)? gc : (gc?[gc]:[]);
      for(const g of arr){
        const vn = (g?.valueName||"").toUpperCase();
        const v  = g?.value || null;
        if(vn==="EMMA_ID" && v){ emma = String(v).trim(); break; }
      }
      if(emma){
        entries.push({ emma, area, event, identifier, effective, onset, expires, certainty, urgency, severity });
      }
    }
  }

  // RSS (por si acaso)
  if (obj?.rss?.channel?.item){
    const list = Array.isArray(obj.rss.channel.item)? obj.rss.channel.item : [obj.rss.channel.item];
    for(const e of list){
      // RSS no suele llevar cap:*; lo dejamos mínimo
      const title = e.title || null;
      entries.push({ emma: null, area: title||null });
    }
  }

  return entries;
}

// 2) Cargar shapes EMMA_ID → geometría (polígonos) y centroids (opcional)
async function loadShapes(){
  const baseDir = fileURLToPath(new URL("../", import.meta.url));
  const shapesPath = path.join(baseDir, "data", "emma_es.geojson");
  const centroidsPath = path.join(baseDir, "data", "emma_es_centroids.csv");

  let shapesIndex = new Map();
  try{
    const txt = await readFile(shapesPath, "utf-8");
    const gj = JSON.parse(txt);
    const feats = Array.isArray(gj.features)? gj.features : [];
    for (const f of feats){
      const id = f?.properties?.EMMA_ID || f?.properties?.emma_id || f?.properties?.EMMA || f?.id;
      if (!id) continue;
      shapesIndex.set(String(id).trim(), f.geometry);
    }
    console.log("Shapes cargados:", shapesIndex.size);
  }catch(e){
    console.warn("NO se pudo leer data/emma_es.geojson:", e?.message||e);
  }

  const centroids = new Map();
  try{
    await access(centroidsPath);
    const txt = await readFile(centroidsPath, "utf-8");
    for(const line of txt.split(/\r?\n/)){
      const [id, lat, lon] = line.split(",").map(s=>s?.trim());
      if(id && lat && lon){
        const la = Number(lat), lo = Number(lon);
        if (Number.isFinite(la) && Number.isFinite(lo)) centroids.set(id, [lo, la]);
      }
    }
    if (centroids.size) console.log("Centroides cargados:", centroids.size);
  }catch{/* opcional */}

  return { shapesIndex, centroids };
}

// 3) Generar GeoJSON a partir de feed + shapes
function buildGeoJSONFromEntries(entries, shapesIndex, centroids){
  const features=[];
  const seen = new Set();

  for(const it of entries){
    if(!it.emma) continue;
    const key = `${it.identifier||""}|${it.emma}|${it.onset||""}|${it.expires||""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const properties = {
      source: "Meteoalarm",
      emma_id: it.emma,
      areaDesc: it.area || null,
      event: it.event || null,
      identifier: it.identifier || null,
      effective: it.effective || null,
      onset: it.onset || null,
      expires: it.expires || null,
      certainty: it.certainty || null,
      urgency: it.urgency || null,
      severity: it.severity || null
    };

    const geom = shapesIndex.get(it.emma);
    if (geom){
      features.push({ type:"Feature", properties, geometry: geom });
    } else if (centroids.has(it.emma)) {
      const [lon, lat] = centroids.get(it.emma);
      features.push({ type:"Feature", properties, geometry: { type:"Point", coordinates:[lon,lat] } });
    } else {
      // sin shape ni centroide → saltar (o podrías crear un Point [0,0] si prefieres)
    }
  }

  return { type:"FeatureCollection", features };
}

// 4) Respaldo AEMET (si queremos rellenar geometría cuando exista)
async function getAemetCAPGeoJSON(){
  if(!AEMET_KEY) return null;
  function mapSeverity(info){
    let sev=info?.severity||"";
    const ecs=Array.isArray(info?.eventCode)?info.eventCode:(info?.eventCode?[info.eventCode]:[]);
    for(const c of ecs){
      const name=(c?.valueName||"").toLowerCase(), val=(c?.value||"").toLowerCase();
      if(name.includes("awareness_level")){
        if(/red|rojo|extreme|severe/.test(val)) sev||="Severe";
        if(/orange|naranja|moderate/.test(val)) sev||="Moderate";
        if(/yellow|amarillo|minor/.test(val)) sev||="Minor";
      }
    } return sev;
  }
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });

  for (const base of AEMET_DESC_URLS){
    try{
      let r = await fetch(base, { dispatcher: agent, headers: { ...UA_JSON, "api_key": AEMET_KEY }});
      let t = await r.text();
      if (!r.ok){ const sep = base.includes("?")?"&":"?"; r = await fetch(base+`${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: UA_JSON }); t = await r.text(); }
      const j = JSON.parse(t); if (!j?.datos) continue;
      let rx = await fetch(j.datos, { dispatcher: agent, headers: UA_XML }); let xml = await rx.text();
      if (!rx.ok || !xml.trim().startsWith("<")){ const sep=j.datos.includes("?")?"&":"?"; rx = await fetch(j.datos+`${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: UA_XML }); xml = await rx.text(); }
      if (!xml.trim().startsWith("<")) continue;

      const cap = parser.parse(xml);
      const g = capToGeoJSON(cap);
      if ((g.features||[]).length) return g;
    }catch{/* prueba siguiente */}
  }
  return null;
}

// ---------- MAIN ----------
async function main(){
  const outDir  = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });
  const outFile = outDir + "avisos.geojson";

  // 1) Cargar shapes + centroids (desde repo)
  const { shapesIndex, centroids } = await loadShapes();

  // 2) Descargar feeds y extraer entradas
  let entries = [];
  for (const url of FEEDS_ES){
    try{
      const {ok, text, status} = await fetchText(url, UA_ATOM);
      if (!ok) { console.warn("Feed no OK", url, status); continue; }
      const part = parseFeedEntries(text);
      entries.push(...part);
    }catch(e){ console.warn("Feed error", url, e?.message||e); }
  }

  // 3) Construir GeoJSON a partir de EMMA_ID + shapes
  let geo = buildGeoJSONFromEntries(entries, shapesIndex, centroids);
  console.log("Meteoalarm join: entries=", entries.length, " → features=", geo.features.length, " (con shapes=", shapesIndex.size, ", centroids=", centroids.size, ")");

  // 4) Si saliera vacío, intentamos respaldo AEMET CAP (puede traer polígonos)
  if (!geo.features.length){
    const aemetG = await getAemetCAPGeoJSON();
    if (aemetG && aemetG.features?.length){
      geo = aemetG;
      console.log("Respaldo AEMET: features=", geo.features.length);
    }
  }

  // 5) Publicar (o conservar último si todo vacío)
  if (geo.features.length){
    await writeFile(outFile, JSON.stringify(geo));
    console.log("Avisos: publicado con", geo.features.length, "features");
  } else {
    try{
      const prev = await readFile(outFile, "utf-8");
      await writeFile(outFile, prev);
      console.warn("Avisos: sin datos; se conserva el último fichero");
    }catch{
      await writeFile(outFile, JSON.stringify({ type:"FeatureCollection", features:[] }));
      console.warn("Avisos: sin datos y sin anterior; se publica vacío");
    }
  }
}

main().catch(e=>{ console.error(e); process.exit(0); });
