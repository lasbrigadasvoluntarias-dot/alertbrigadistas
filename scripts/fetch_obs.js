import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const AEMET_KEY = process.env.AEMET_API_KEY;
if (!AEMET_KEY) { console.error("Falta AEMET_API_KEY"); process.exit(1); }

async function main(){
  const step1 = await fetch(`https://opendata.aemet.es/opendata/api/observacion/convencional/todas?api_key=${encodeURIComponent(AEMET_KEY)}`);
  const j = await step1.json();
  if (!j?.datos) throw new Error("Sin datos en descriptor OBS");

  // descarga datos (JSON) con reintento ?api_key
  let r = await fetch(j.datos);
  let txt = await r.text();
  if (!r.ok || !txt.trim().startsWith("[")) {
    const sep = j.datos.includes("?") ? "&" : "?";
    r = await fetch(j.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`);
    txt = await r.text();
  }
  const arr = JSON.parse(txt);

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
  const geo = { type:"FeatureCollection", features:feats };

  const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });
  await writeFile(outDir + "obs.geojson", JSON.stringify(geo));
  console.log("Escrito dist/obs.geojson con", feats.length, "estaciones");
}
main().catch(e=>{ console.error(e); process.exit(1); });
