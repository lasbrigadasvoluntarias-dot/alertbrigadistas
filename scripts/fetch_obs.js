// Node 20 (GitHub Actions)
// deps: undici
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";

const AEMET_KEY = process.env.AEMET_API_KEY || "";
const agent = new Agent({ connect: { family: 4, timeout: 15000 } });
const UA = { "User-Agent": "alertbrigadistas/1.0 (+github actions)" };

async function main(){
  const outDir = fileURLToPath(new URL("../dist/", import.meta.url));
  await mkdir(outDir, { recursive: true });
  const outFile = outDir + "obs.geojson";

  let desc = null;
  try{
    const r1 = await fetch(`https://opendata.aemet.es/opendata/api/observacion/convencional/todas?api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
    const t1 = await r1.text();
    try { const j = JSON.parse(t1); if (r1.ok && j?.datos) desc = j; } catch {}
  }catch(e){ console.warn("OBS descriptor fallo", e?.message||e); }

  let feats = [];
  if (desc?.datos){
    try{
      let r2 = await fetch(desc.datos, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
      let t2 = await r2.text();
      if (!r2.ok || !t2.trim().startsWith("[")){
        const sep = desc.datos.includes("?") ? "&" : "?";
        r2 = await fetch(desc.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
        t2 = await r2.text();
      }
      let arr = [];
      try { arr = JSON.parse(t2); } catch {}
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
      console.log("Obs: estaciones:", feats.length);
    }catch(e){ console.warn("OBS datos fallo", e?.message||e); }
  }

  if (feats.length){
    await writeFile(outFile, JSON.stringify({ type:"FeatureCollection", features:feats }));
  } else {
    try {
      const prev = await readFile(outFile, "utf-8");
      await writeFile(outFile, prev);
      console.warn("Obs: sin datos; se conserva el último fichero");
    } catch {
      await writeFile(outFile, JSON.stringify({ type:"FeatureCollection", features:[] }));
      console.warn("Obs: sin datos y sin anterior; publicado vacío");
    }
  }
}

main().catch(e=>{ console.error(e); process.exit(0); });


