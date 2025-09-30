// scripts/fetch_avisos.js
// Node 20+
// deps: fast-xml-parser, undici
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";
import { setTimeout as sleep } from "node:timers/promises";

// --- Config HTTP ---
const agent = new Agent({ connect: { family: 4, timeout: 20000 } });
const HEADERS_XML = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
};

// --- Feeds (directos + mirrors) ---
const FEEDS_BASE = [
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain",
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-rss-spain"
];
function mirror(url) {
  const http  = "https://r.jina.ai/http://"  + url.replace(/^https?:\/\//, "");
  const https = "https://r.jina.ai/https://" + url.replace(/^https?:\/\//, "");
  return [http, https];
}

// --- Rutas de E/S ---
const OUT_DIR   = fileURLToPath(new URL("../dist/", import.meta.url));
const OUT_FILE  = OUT_DIR + "avisos.geojson";
const DIAG_FILE = OUT_DIR + "avisos_diag.json";
const SHP_FILE  = fileURLToPath(new URL("../data/emma_es.geojson", import.meta.url));
const CTR_FILE  = fileURLToPath(new URL("../data/emma_centroids.json", import.meta.url));

// --- Utils ---
const uniq = arr => Array.from(new Set(arr));
const asArray = x => Array.isArray(x) ? x : (x==null ? [] : [x]);

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

async function loadEmmaCentroidsMutable(){
  let obj = {};
  try { obj = JSON.parse(await readFile(CTR_FILE, "utf-8")); } catch {}
  return obj; // { EMMA_ID: [lon,lat], ...}
}
async function saveEmmaCentroids(obj){
  await writeFile(CTR_FILE, JSON.stringify(obj, null, 2));
}

// círculo geodésico aprox en km → Polygon
function circlePolygonFromKm(lon, lat, radiusKm = 60, steps = 64){
  const R = 6371, rad = radiusKm / R;
  const lat0 = lat * Math.PI/180, lon0 = lon * Math.PI/180;
  const ring = [];
  for (let i=0;i<=steps;i++){
    const brng = (2*Math.PI*i)/steps;
    const latp = Math.asin(Math.sin(lat0)*cos(rad)+cos(lat0)*sin(rad)*Math.cos(brng));
    const lonp = lon0 + Math.atan2(Math.sin(brng)*sin(rad)*cos(lat0), cos(rad)-Math.sin(lat0)*Math.sin(latp));
    ring.push([lonp*180/Math.PI, latp*180/Math.PI]);
  }
  return { type:"Polygon", coordinates:[ring] };
  function sin(x){return Math.sin(x)}; function cos(x){return Math.cos(x)}
}

// jitter determinista por EMMA_ID alrededor del centro de España (fallback aproximado)
function pseudoCentroidFor(emma){
  const baseLon = -3.7, baseLat = 40.3;
  let h = 0;
  for (let i=0;i<emma.length;i++) h = (h*31 + emma.charCodeAt(i)) >>> 0;
  const ang = (h % 360) * Math.PI/180;
  const distKm = 90 + (h % 60); // 90–150 km
  const dx = Math.cos(ang) * distKm;
  const dy = Math.sin(ang) * distKm;
  const lat = baseLat + (dy / 111);
  const lon = baseLon + (dx / (111 * Math.cos(baseLat * Math.PI/180)));
  return [lon, lat];
}

// Descarga y parsea feed (intenta directos, cache-busting y mirrors)
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
        url: res.url, status: res.status, ok: res.ok, contentType: res.ct,
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

  // EMMA_ID
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

// --- Geocodificación Nominatim (1 req/seg) ---
async function geocodeAreaDesc(areaDesc){
  const q = encodeURIComponent(`${areaDesc} España`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=${q}`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": "alertbrigadistas/1.0 (+github actions; contacto: repo GitHub)",
      "Accept": "application/json"
    }
  });
  if (!r.ok) return null;
  const arr = await r.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const hit = arr[0];
  const lat = Number(hit.lat), lon = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const bb = hit.boundingbox?.map(Number);
  return { lon, lat, bbox: Array.isArray(bb) && bb.length === 4 ? bb : null };
}

// --- MAIN ---
async function main(){
  await mkdir(OUT_DIR, { recursive: true });
  const diag = {
    feedAttempts: [],
    totalEntries: 0,
    joined: 0,
    missingShapes: [],
    usedCircles: 0,     // centroid_circle
    usedShapes: 0,      // shape real
    usedApprox: 0,      // approx_circle
    usedGeocoded: 0,    // geocoded_circle
    centroidsCount: 0,
    error: null,
    sampleProps: null
  };

  try{
    // Índices
    const emmaIndex = await loadEmmaShapes();
    const centroidObj = await loadEmmaCentroidsMutable();
    const centroidIndex = new Map(Object.entries(centroidObj).map(([k,v]) => [k.trim(), v]));
    diag.centroidsCount = centroidIndex.size;

    // Feed
    const { obj, attempts } = await fetchAndParseFeed();
    diag.feedAttempts = attempts;
    if (!obj){
      diag.error = "feed: imposible obtener Atom/RSS válido";
      await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
      await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
      return;
    }

    // Parse → alerts
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

      // 1) polígono real (shape)
      const geom = it.emma ? emmaIndex.get(it.emma) : null;
      if (geom){
        features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma, geometrySource:"shape" }, geometry: geom });
        diag.usedShapes++;
        continue;
      }

      // 2) centroide ya conocido
      const ctrKnown = it.emma ? centroidIndex.get(it.emma) : null;
      if (Array.isArray(ctrKnown) && ctrKnown.length===2 && ctrKnown.every(n=>Number.isFinite(Number(n)))){
        const [lon, lat] = ctrKnown.map(Number);
        const poly = circlePolygonFromKm(lon, lat, 60);
        features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma, geometrySource:"centroid_circle", radiusKm:60 }, geometry: poly });
        diag.usedCircles++;
        continue;
      }

      // 3) geocodificar areaDesc → cachear como centroid
      if (it.emma && it.props.areaDesc){
        await sleep(1100); // respetar 1 req/s
        try{
          const g = await geocodeAreaDesc(it.props.areaDesc);
          if (g){
            centroidObj[it.emma] = [g.lon, g.lat];
            centroidIndex.set(it.emma, [g.lon, g.lat]);
            const poly = circlePolygonFromKm(g.lon, g.lat, 60);
            features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma, geometrySource:"geocoded_circle", radiusKm:60 }, geometry: poly });
            diag.usedGeocoded++;
            continue;
          }
        }catch{/* ignora y pasa al approx */}
      }

      // 4) fallback aproximado (para que siempre se vea algo)
      if (it.emma){
        const [lon, lat] = pseudoCentroidFor(it.emma);
        const poly = circlePolygonFromKm(lon, lat, 60);
        features.push({ type:"Feature", properties:{ ...it.props, EMMA_ID: it.emma, geometrySource:"approx_circle", approximate:true, radiusKm:60 }, geometry: poly });
        diag.usedApprox++;
        continue;
      }

      // 5) sin EMMA_ID
      missing.push("NO_EMMA_ID");
    }

    diag.joined = features.length;
    diag.missingShapes = uniq(missing).sort();
    diag.sampleProps = features[0]?.properties || null;

    // Persistir centroides aprendidos por geocodificación
    await saveEmmaCentroids(centroidObj);

    // Salidas
    await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features }));
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
    console.log(`Avisos publicados: ${features.length} (shapes=${diag.usedShapes}, geocoded=${diag.usedGeocoded}, centroids=${diag.usedCircles}, approx=${diag.usedApprox})`);
  }catch(err){
    diag.error = "fatal: " + (err?.message||String(err));
    await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
  }
}

main().catch(e=>{ console.error(e); });
