import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

const AEMET_KEY = process.env.AEMET_API_KEY;
if (!AEMET_KEY) { console.error("Falta AEMET_API_KEY"); process.exit(1); }

const agent = new Agent({ connect: { family: 4, timeout: 15000 } });
const UA = { "User-Agent": "alertbrigadistas/1.0 (+github actions)" };

async function main(){
  // Paso 1: descriptor
  let r1, txt1;
  try {
    r1 = await fetch(`https://opendata.aemet.es/opendata/api/observacion/convencional/todas?api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
    txt1 = await r1.text();
  } catch (e) {
    console.error("OBS STEP1 fetch failed:", e?.code||e?.message||e);
  }
  let j;
  try { j = JSON.parse(txt1||""); } catch { j = null; }
  const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });

  if (!j?.datos){
    // publicar vacío para no romper
    await writeFile(outDir + "obs.geojson", JSON.stringify({ type:"FeatureCollection", features:[] }));
    console.log("Obs: publicado vacío (sin descriptor)");
    return;
  }

  // Paso 2: datos
  const hJSON = { ...UA, "Accept":"application/json" };
  let r2 = await fetch(j.datos, { dispatcher: agent, headers: hJSON });
  let txt2 = await r2.text();
  if (!r2.ok || !txt2.trim().startsWith("[")){
    const sep = j.datos.includes("?") ? "&" : "?";
    r2 = await fetch(j.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: hJSON });
    txt2 = await r2.text();
  }
  let arr; try { arr = JSON.parse(txt2); } catch { arr = []; }

  const feats=[];
  for (const it of arr){
    const lon = Number(it.lon ?? it.longitude), lat = Number(it.lat ?? it.latitude);
    if (!Number.isFinite(lon)||!Number.isFinite(lat)) continue;
    feats.push({
      type:"Feature",
      properties:{
        id:it.idema||it.id||null, nombre:it.ubi||it.nom||null, instante:it.fint||it.fecha||null,
        ta:it.ta??null, hr:it.hr??null, vv:it.vv??null, dv:it.dv??null, pres:it.pres??null, prec:it.prec??it.pcp??null
      },
      geometry:{ type:"Point", coordinates:[lon,lat] }
    });
  }

  await writeFile(outDir + "obs.geojson", JSON.stringify({ type:"FeatureCollection", features:feats }));
  console.log("Escrito dist/obs.geojson con", feats.length, "estaciones");
}
main().catch(e=>{ console.error(e); process.exit(0); /* no romper deploy */ });

