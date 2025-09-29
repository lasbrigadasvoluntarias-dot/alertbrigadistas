// Node 20 (GitHub Actions)
// deps: fast-xml-parser, undici
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";

const agent = new Agent({ connect: { family: 4, timeout: 15000 } });
const UA_XML  = { "User-Agent": "alertbrigadistas/1.0 (+github actions)", "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml" };

const METEOALARM_FEED = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain";

const OUT_DIR   = fileURLToPath(new URL("../dist/", import.meta.url));
const OUT_FILE  = OUT_DIR + "avisos.geojson";
const DIAG_FILE = OUT_DIR + "avisos_diag.json";
const SHP_FILE  = fileURLToPath(new URL("../data/emma_es.geojson", import.meta.url));

// util
const uniq = arr => Array.from(new Set(arr));
const asArray = x => Array.isArray(x)? x : (x==null? [] : [x]);

async function loadEmmaShapes(){
  const txt = await readFile(SHP_FILE, "utf-8");
  const gj = JSON.parse(txt);
  if (!gj || gj.type!=="FeatureCollection" || !Array.isArray(gj.features)) {
    throw new Error("data/emma_es.geojson no es una FeatureCollection válida");
  }
  const idx = new Map();
  for (const f of gj.features){
    const id = f?.properties?.EMMA_ID;
    if (typeof id === "string" && f.geometry) idx.set(id.trim(), f.geometry);
  }
  if (!idx.size) throw new Error("data/emma_es.geojson no contiene EMMA_ID indexables");
  return idx;
}

async function fetchFeed(){
  const r = await fetch(METEOALARM_FEED, { dispatcher: agent, headers: UA_XML });
  const xml = await r.text();
  if (!r.ok || !xml.trim().startsWith("<")) throw new Error("Feed Meteoalarm no válido");
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });
  return parser.parse(xml);
}

function extractEntries(feedObj){
  const entries = asArray(feedObj?.feed?.entry);
  const out = [];
  for (const e of entries){
    const geos = asArray(e?.geocode);
    let emma = null;
    for (const g of geos){
      const vn = (g?.valueName || g?.valuename || "").toUpperCase();
      const vv = g?.value || g?.val || "";
      if (vn==="EMMA_ID" && typeof vv==="string") { emma = vv.trim(); break; }
    }
    if (!emma) continue;
    out.push({
      emma,
      props: {
        source:"MeteoalarmFeed",
        areaDesc: e?.areaDesc || null,
        event:    e?.event || null,
        severity: e?.severity || null,
        urgency:  e?.urgency || null,
        certainty:e?.certainty || null,
        onset:    e?.onset || e?.effective || null,
        expires:  e?.expires || null,
        identifier: e?.identifier || e?.id || null,
        headline: e?.title || null,
        sent:     e?.sent || e?.updated || null
      }
    });
  }
  return out;
}

async function main(){
  await mkdir(OUT_DIR, { recursive: true });
  const diag = { feed: METEOALARM_FEED, totalEntries:0, joined:0, missingShapes:[], error:null, sampleProps:null };

  try{
    // 1) Carga shapes
    let emmaIndex;
    try { emmaIndex = await loadEmmaShapes(); }
    catch(e){
      diag.error = "shapes: " + (e?.message||String(e));
      await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
      await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
      console.warn(diag.error);
      return;
    }

    // 2) Feed
    let feedObj;
    try { feedObj = await fetchFeed(); }
    catch(e){
      diag.error = "feed: " + (e?.message||String(e));
      // conservar último si existe; si no, vacío
      try{
        const prev = await readFile(OUT_FILE, "utf-8");
        await writeFile(OUT_FILE, prev);
      }catch{
        await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
      }
      await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
      console.warn(diag.error);
      return;
    }

    // 3) Entradas y join
    const items = extractEntries(feedObj);
    diag.totalEntries = items.length;

    const features = [];
    const missing = [];
    const seen = new Set();

    for (const it of items){
      const geom = emmaIndex.get(it.emma);
      if (!geom){ missing.push(it.emma); continue; }
      const id = (it.props.identifier || it.emma) + "|" + (it.props.onset || "") + "|" + (it.props.expires || "");
      if (seen.has(id)) continue;
      seen.add(id);
      features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma }, geometry: geom });
    }

    diag.joined = features.length;
    diag.missingShapes = uniq(missing).sort();
    diag.sampleProps = features[0]?.properties || null;

    // 4) Escribir resultados
    await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features }));
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
    console.log(`Avisos: ${features.length} features publicadas. EMMA sin shape: ${diag.missingShapes.length}`);
  }catch(err){
    // pase lo que pase, dejamos diag y fichero válido
    diag.error = "fatal: " + (err?.message||String(err));
    try{
      const prev = await readFile(OUT_FILE, "utf-8");
      await writeFile(OUT_FILE, prev);
    }catch{
      await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
    }
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
    console.error(diag.error);
  }
}

main().catch(e=>{ console.error(e); });

