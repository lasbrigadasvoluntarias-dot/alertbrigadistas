// Node 20 (GitHub Actions)
// deps: fast-xml-parser, undici
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";

const agent = new Agent({ connect: { family: 4, timeout: 20000 } });

// UA de navegador para evitar filtros
const HEADERS_XML = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
};

// Feeds directos y mirrors (fallback)
const FEEDS_BASE = [
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain",
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-rss-spain"
];
function mirror(url) {
  const http  = "https://r.jina.ai/http://"  + url.replace(/^https?:\/\//, "");
  const https = "https://r.jina.ai/https://" + url.replace(/^https?:\/\//, "");
  return [http, https];
}

const OUT_DIR   = fileURLToPath(new URL("../dist/", import.meta.url));
const OUT_FILE  = OUT_DIR + "avisos.geojson";
const DIAG_FILE = OUT_DIR + "avisos_diag.json";
const SHP_FILE  = fileURLToPath(new URL("../data/emma_es.geojson", import.meta.url));
const CTR_FILE  = fileURLToPath(new URL("../data/emma_centroids.json", import.meta.url)); // <-- NUEVO

const uniq = arr => Array.from(new Set(arr));
const asArray = x => Array.isArray(x)? x : (x==null? [] : [x]);

async function fetchText(url){
  const r = await fetch(url, { dispatcher: agent, headers: HEADERS_XML, redirect: "follow" });
  const text = await r.text();
  const ct = r.headers.get("content-type") || "";
  return { ok: r.ok, status: r.status, ct, text, url };
}

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

async function loadEmmaCentroids(){
  try{
    const txt = await readFile(CTR_FILE, "utf-8");
    const obj = JSON.parse(txt); // { EMMA_ID: [lon,lat], ... }
    const m = new Map();
    for (const k of Object.keys(obj||{})){
      const v = obj[k];
      if (Array.isArray(v) && v.length===2 && v.every(n => Number.isFinite(Number(n)))){
        m.set(k.trim(), [Number(v[0]), Number(v[1])]);
      }
    }
    return m; // puede estar vacío
  }catch{
    return new Map(); // si no existe el archivo, seguimos sin centroids
  }
}

// círculo aproximado en km → Polygon
function circlePolygonFromKm(lon, lat, radiusKm = 20, steps = 64){
  const R = 6371;
  const rad = radiusKm / R;
  const lat0 = lat * Math.PI/180;
  const lon0 = lon * Math.PI/180;
  const ring = [];
  for (let i=0;i<=steps;i++){
    const brng = (2*Math.PI*i)/steps;
    const latp = Math.asin(Math.sin(lat0)*Math.cos(rad)+Math.cos(lat0)*Math.sin(rad)*Math.cos(brng));
    const lonp = lon0 + Math.atan2(Math.sin(brng)*Math.sin(rad)*Math.cos(lat0), Math.cos(rad)-Math.sin(lat0)*Math.sin(latp));
    ring.push([lonp*180/Math.PI, latp*180/Math.PI]);
  }
  return { type:"Polygon", coordinates:[ring] };
}

// intenta varios (directo, cache-busting y mirrors)
async function fetchAndParseFeed(){
  const attempts = [];
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });

  const urls = [];
  for (const base of FEEDS_BASE){
    urls.push(base);
    urls.push(base + "?_=" + Date.now());
    urls.push(...mirror(base));
  }

  for (const u of urls){
    try{
      const res = await fetchText(u);
      attempts.push({
        url: res.url,
        status: res.status,
        ok: res.ok,
        contentType: res.ct,
        snippet: res.text.slice(0, 180).replace(/\s+/g, " ")
      });
      const looksXml = res.text.trim().startsWith("<");
      if (!looksXml) continue;

      let obj;
      try { obj = parser.parse(res.text); } catch { obj = null; }
      const hasEntries = (obj?.feed?.entry) || (obj?.rss?.channel?.item);
      if (hasEntries) return { obj, attempts };
    }catch(e){
      attempts.push({ url: u, error: e?.message || String(e) });
    }
  }
  return { obj: null, attempts };
}

function extractEntries(feedObj){
  if (feedObj?.feed?.entry){
    const entries = asArray(feedObj.feed.entry);
    return entries.map(e => ({ e, isAtom: true }));
  }
  if (feedObj?.rss?.channel?.item){
    const items = asArray(feedObj.rss.channel.item);
    return items.map(e => ({ e, isAtom: false }));
  }
  return [];
}

function mapEntryToAlert(entryWrap){
  const { e, isAtom } = entryWrap;

  let emma = null;
  const geos = asArray(e?.geocode);
  for (const g of geos){
    const vn = (g?.valueName || g?.valuename || "").toUpperCase();
    const vv = g?.value || g?.val || "";
    if (vn === "EMMA_ID" && typeof vv === "string") { emma = vv.trim(); break; }
  }

  const areaDesc = e?.areaDesc || null;
  const event    = e?.event || null;
  const severity = e?.severity || null;
  const urgency  = e?.urgency || null;
  const certainty= e?.certainty || null;
  const onset    = e?.onset || e?.effective || null;
  const expires  = e?.expires || null;
  const identifier = e?.identifier || e?.id || null;
  const headline = isAtom ? (e?.title || null) : (e?.title?.["#text"] || e?.title || null);
  const sent     = e?.sent || e?.updated || null;

  return { emma, props: { source:"MeteoalarmFeed", areaDesc, event, severity, urgency, certainty, onset, expires, identifier, headline, sent } };
}

async function main(){
  await mkdir(OUT_DIR, { recursive: true });
  const diag = {
    feedAttempts: [],
    totalEntries: 0,
    joined: 0,
    missingShapes: [],
    usedCircles: 0,          // <-- NUEVO
    usedShapes: 0,           // <-- NUEVO
    error: null,
    sampleProps: null
  };

  try{
    // índices
    const emmaIndex = await loadEmmaShapes();
    const centroidIndex = await loadEmmaCentroids();

    // feed
    const { obj, attempts } = await fetchAndParseFeed();
    diag.feedAttempts = attempts;

    if (!obj){
      diag.error = "feed: imposible obtener Atom/RSS válido";
      await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
      await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
      return;
    }

    const rawEntries = extractEntries(obj);
    const alerts = rawEntries.map(mapEntryToAlert).filter(Boolean);
    diag.totalEntries = alerts.length;

    const features = [];
    const missing = [];
    const seen = new Set();

    for (const it of alerts){
      const key = (it.props.identifier || it.emma) + "|" + (it.props.onset || "") + "|" + (it.props.expires || "");
      if (seen.has(key)) continue;
      seen.add(key);

      // 1) ¿tenemos shape?
      const geom = it.emma ? emmaIndex.get(it.emma) : null;
      if (geom){
        features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma, geometrySource:"shape" }, geometry: geom });
        diag.usedShapes++;
        continue;
      }

      // 2) ¿tenemos centróide? → círculo de respaldo
      const ctr = it.emma ? centroidIndex.get(it.emma) : null;
      if (ctr){
        const [lon, lat] = ctr;
        const poly = circlePolygonFromKm(lon, lat, 20 /* km */);
        features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma, geometrySource:"centroid_circle", radiusKm:20 }, geometry: poly });
        diag.usedCircles++;
        continue;
      }

      // 3) ni shape ni centróide: lo anotamos como faltante
      if (it.emma) missing.push(it.emma); else missing.push("NO_EMMA_ID");
    }

    diag.joined = features.length;
    diag.missingShapes = uniq(missing).sort();
    diag.sampleProps = features[0]?.properties || null;

    await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features }));
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
    console.log(`Avisos: ${features.length} publicados (shapes=${diag.usedShapes}, círculos=${diag.usedCircles}). Faltan=${diag.missingShapes.length}`);
  }catch(err){
    diag.error = "fatal: " + (err?.message||String(err));
    await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
  }
}

main().catch(e=>{ console.error(e); });

