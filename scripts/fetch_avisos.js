// Node 20 (GitHub Actions)
// deps: fast-xml-parser, undici
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";
import { Agent } from "undici";

const agent = new Agent({ connect: { family: 4, timeout: 20000 } });

// ⚠️ UA más “de navegador” para evitar filtros de bots
const HEADERS_XML = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5"
};

const FEEDS = [
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-spain",
  "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-rss-spain"
];

const OUT_DIR   = fileURLToPath(new URL("../dist/", import.meta.url));
const OUT_FILE  = OUT_DIR + "avisos.geojson";
const DIAG_FILE = OUT_DIR + "avisos_diag.json";
const SHP_FILE  = fileURLToPath(new URL("../data/emma_es.geojson", import.meta.url));

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

async function fetchText(url){
  const r = await fetch(url, { dispatcher: agent, headers: HEADERS_XML, redirect: "follow" });
  const text = await r.text();
  const ct = r.headers.get("content-type") || "";
  return { ok: r.ok, status: r.status, ct, text, url };
}

// Intenta varias variantes y devuelve {obj, diagAttempts: [...]}
async function fetchAndParseFeed(){
  const attempts = [];
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"", removeNSPrefix:true });

  // lista de intentos (con cache-busting)
  const tries = [];
  for (const base of FEEDS) {
    tries.push(base);
    tries.push(base + "?_=" + Date.now());
  }

  for (const u of tries){
    try{
      const res = await fetchText(u);
      attempts.push({
        url: res.url,
        status: res.status,
        ok: res.ok,
        contentType: res.ct,
        snippet: res.text.slice(0, 200).replace(/\s+/g, " ")
      });
      // comprobación mínima: que empiece por '<' y contenga <feed o <rss
      const looksXml = res.text.trim().startsWith("<");
      if (!res.ok || !looksXml) continue;
      const obj = parser.parse(res.text);
      const hasEntries = (obj?.feed?.entry) || (obj?.rss?.channel?.item);
      if (hasEntries) return { obj, attempts };
    }catch(e){
      attempts.push({ url: u, error: e?.message || String(e) });
    }
  }
  return { obj: null, attempts };
}

function extractEntries(feedObj){
  // Atom
  if (feedObj?.feed?.entry){
    const entries = asArray(feedObj.feed.entry);
    return entries.map(e => ({ e, isAtom: true }));
  }
  // RSS
  if (feedObj?.rss?.channel?.item){
    const items = asArray(feedObj.rss.channel.item);
    return items.map(e => ({ e, isAtom: false }));
  }
  return [];
}

// Extrae EMMA_ID y metadatos mínimos desde Atom/RSS
function mapEntryToAlert(entryWrap){
  const { e, isAtom } = entryWrap;

  // geocode en Atom (namespaces ya removidos)
  let emma = null;
  const geos = asArray(e?.geocode);
  for (const g of geos){
    const vn = (g?.valueName || g?.valuename || "").toUpperCase();
    const vv = g?.value || g?.val || "";
    if (vn === "EMMA_ID" && typeof vv === "string") { emma = vv.trim(); break; }
  }

  // campos comunes
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
  const diag = { feedAttempts: [], totalEntries:0, joined:0, missingShapes:[], error:null, sampleProps:null };

  try{
    // 1) shapes
    let emmaIndex;
    try { emmaIndex = await loadEmmaShapes(); }
    catch(e){
      diag.error = "shapes: " + (e?.message||String(e));
      await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
      await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
      return;
    }

    // 2) feed (con diagnóstico detallado)
    const { obj, attempts } = await fetchAndParseFeed();
    diag.feedAttempts = attempts;

    if (!obj){
      diag.error = "feed: imposible obtener Atom/RSS válido";
      // conserva último o vacío
      try{
        const prev = await readFile(OUT_FILE, "utf-8");
        await writeFile(OUT_FILE, prev);
      }catch{
        await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
      }
      await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
      return;
    }

    // 3) entries → alerts
    const rawEntries = extractEntries(obj);
    const alerts = rawEntries.map(mapEntryToAlert).filter(a => a);
    diag.totalEntries = alerts.length;

    const features = [];
    const missing = [];
    const seen = new Set();

    for (const it of alerts){
      if (!it.emma){ missing.push("NO_EMMA_ID"); continue; }
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

    await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features }));
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
    console.log(`Avisos: ${features.length} features publicadas. EMMA sin shape: ${diag.missingShapes.length}`);
  }catch(err){
    diag.error = "fatal: " + (err?.message||String(err));
    try{
      const prev = await readFile(OUT_FILE, "utf-8");
      await writeFile(OUT_FILE, prev);
    }catch{
      await writeFile(OUT_FILE, JSON.stringify({ type:"FeatureCollection", features:[] }));
    }
    await writeFile(DIAG_FILE, JSON.stringify(diag, null, 2));
  }
}

main().catch(e=>{ console.error(e); });
