// Node 20 en GitHub Actions
// deps: fast-xml-parser, undici
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";

const AEMET_KEY = process.env.AEMET_API_KEY || "";
const agent = new Agent({ connect: { family: 4, timeout: 15000 } }); // fuerza IPv4
const UA_JSON = { "User-Agent": "alertbrigadistas/1.0 (+github actions)", "Accept": "application/json" };
const UA_XML  = { "User-Agent": "alertbrigadistas/1.0 (+github actions)", "Accept": "application/xml, text/xml" };

// --- Endpoints ---
const AEMET_DESC_URLS = [
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion/area/esp",
  "https://opendata.aemet.es/opendata/api/avisos_cap/ultimaelaboracion?area=esp"
];

// Feeds públicas de MeteoAlarm (España)
const METEOALARM_FEEDS = [
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain",
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-rss-spain"
];

// ---------- utilidades ----------
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
    const latp=Math.asin(Math.sin(lat0)*Math.cos(rad)+Math.cos(lat0)*Math.sin(rad)*Math.cos(brng));
    const lonp=lon0+Math.atan2(Math.sin(brng)*Math.sin(rad)*Math.cos(lat0),Math.cos(rad)-Math.sin(lat0)*Math.sin(latp));
    ring.push([lonp*180/Math.PI, latp*180/Math.PI]);
  }
  return ring;
}
function mapSeverity(info){
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
      const severity = mapSeverity(info);
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

// ---------- fetch helpers ----------
async function fetchText(url, headers){
  const r = await fetch(url, { dispatcher: agent, headers });
  const t = await r.text();
  return { ok:r.ok, status:r.status, text:t };
}

// 1) AEMET (preferente)
async function getAemetCAPXml(){
  if (!AEMET_KEY) return null;
  for (const base of AEMET_DESC_URLS){
    // a) api_key en cabecera
    try{
      let {ok,status,text} = await fetchText(base, { ...UA_JSON, "api_key": AEMET_KEY });
      if (ok){
        try{
          const j = JSON.parse(text);
          if (j?.datos){
            // descarga del CAP
            let cap = await fetchText(j.datos, UA_XML);
            if (!cap.ok || !cap.text.trim().startsWith("<")){
              const sep = j.datos.includes("?") ? "&" : "?";
              cap = await fetchText(j.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, UA_XML);
            }
            if (cap.ok && cap.text.trim().startsWith("<")) return cap.text;
          }
        }catch{/* sigue */}
      }
    }catch{/* sigue */}
    // b) api_key en query
    try{
      const sep = base.includes("?") ? "&" : "?";
      let {ok,status,text} = await fetchText(base + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, UA_JSON);
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
        }catch{/* sigue */}
      }
    }catch{/* sigue */}
  }
  return null;
}

// 2) METEOALARM (respaldo público)
function parseFeedForCapLinks(xml){
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });
  const obj = parser.parse(xml||"");
  const links = new Set();

  // Atom
  if (obj?.feed?.entry){
    const entries = Array.isArray(obj.feed.entry)? obj.feed.entry: [obj.feed.entry];
    for (const e of entries){
      // Manejar <link href="">
      const ls = e.link ? (Array.isArray(e.link)? e.link : [e.link]) : [];
      for (const l of ls){
        const href = l?.href || l;
        const type = (l?.type || "").toLowerCase();
        if (typeof href === "string" && (/\.xml($|\?)/i.test(href) || type.includes("xml") || type.includes("cap"))) {
          links.add(href);
        }
      }
      // A veces el CAP va en <id> o <content> con url
      if (typeof e.id === "string" && /\.xml($|\?)/i.test(e.id)) links.add(e.id);
      const c = e.content;
      if (typeof c === "string" && /^https?:\/\//.test(c) && /\.xml($|\?)/i.test(c)) links.add(c);
      if (c?.url && /\.xml($|\?)/i.test(c.url)) links.add(c.url);
    }
  }

  // RSS
  const ch = obj?.rss?.channel;
  if (ch?.item){
    const items = Array.isArray(ch.item) ? ch.item : [ch.item];
    for (const it of items){
      if (typeof it.link === "string" && /\.xml($|\?)/i.test(it.link)) links.add(it.link);
      if (typeof it.guid === "string" && /\.xml($|\?)/i.test(it.guid)) links.add(it.guid);
      if (it.guid?.["#text"] && /\.xml($|\?)/i.test(it.guid["#text"])) links.add(it.guid["#text"]);
    }
  }

  return Array.from(links);
}

async function fetchMeteoalarmCAPs(){
  // Devuelve XML concatenados (array) de mensajes CAP para España
  for (const feedUrl of METEOALARM_FEEDS){
    try{
      const {ok, text} = await fetchText(feedUrl, { ...UA_XML, "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml" });
      if (!ok) continue;
      const capLinks = parseFeedForCapLinks(text).slice(0, 60); // límite prudente
      const xmls = [];
      // descarga concurrente con límites simples
      const batch = 10;
      for (let i=0; i<capLinks.length; i+=batch){
        const slice = capLinks.slice(i, i+batch);
        const got = await Promise.all(slice.map(async (u)=>{
          try{
            const r = await fetch(u, { dispatcher: agent, headers: UA_XML });
            const t = await r.text();
            return (r.ok && t.trim().startsWith("<")) ? t : null;
          }catch{return null;}
        }));
        for (const x of got) if (x) xmls.push(x);
      }
      if (xmls.length) return xmls;
    }catch{/* probar siguiente feed */}
  }
  return [];
}

// 3) CAP XML -> GeoJSON (varios mensajes)
function capXmlArrayToGeoJSON(xmlArr){
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });
  const features = [];
  const seen = new Set(); // evitar duplicados por identifier

  for (const xml of xmlArr){
    let cap;
    try { cap = parser.parse(xml); } catch { continue; }
    const coll = capToGeoJSON(cap);
    for (const f of coll.features){
      const id = (f.properties?.identifier || "") + "|" + (f.properties?.onset || "") + "|" + (f.properties?.expires || "");
      if (!seen.has(id)){ seen.add(id); features.push(f); }
    }
  }
  return { type:"FeatureCollection", features };
}

// ---------- main ----------
async function main(){
  const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });

  // 1) AEMET directo
  let geo = null;
  try{
    const capXml = await getAemetCAPXml();
    if (capXml){
      const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });
      const cap = parser.parse(capXml);
      const g = capToGeoJSON(cap);
      if ((g.features||[]).length) geo = g;
    }
  }catch{/* seguimos al respaldo */}

  // 2) Respaldo MeteoAlarm
  if (!geo){
    try{
      const xmlArr = await fetchMeteoalarmCAPs();
      if (xmlArr.length){
        const g = capXmlArrayToGeoJSON(xmlArr);
        if ((g.features||[]).length) geo = g;
      }
    }catch{/* nada */}
  }

  // 3) Escribir: si tenemos g, publicamos; si no, conservamos el último; si no existe, vacío
  const outFile = outDir + "avisos.geojson";
  if (geo && (geo.features||[]).length){
    await writeFile(outFile, JSON.stringify(geo));
    console.log("Avisos: publicado con", geo.features.length, "features");
  } else {
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

main().catch(e=>{ console.error(e); /* no romper deploy */ process.exit(0); });

