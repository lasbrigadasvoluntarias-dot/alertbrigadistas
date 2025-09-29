// Node 20
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
  const diagFile = outDir + "obs_diag.json";

  let diag = { descriptorOk:false, datosUrl:null, parseCount:0, error:null };

  let desc = null;
  try{
    const r1 = await fetch(`https://opendata.aemet.es/opendata/api/observacion/convencional/todas?api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
    const t1 = await r1.text();
    const j = JSON.parse(t1);
    if (r1.ok && j?.datos) { desc = j; diag.descriptorOk = true; }
  }catch(e){ diag.error = "descriptor: "+(e?.message||String(e)); }

  let feats = [];
  if (desc?.datos){
    try{
      diag.datosUrl = desc.datos;
      let r2 = await fetch(desc.datos, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
      let t2 = await r2.text();
      if (!r2.ok || !t2.trim().startsWith("[")){
        const sep = desc.datos.includes("?") ? "&" : "?";
        r2 = await fetch(desc.datos + `${sep}api_key=${encodeURIComponent(AEMET_KEY)}`, { dispatcher: agent, headers: { ...UA, "Accept":"application/json" }});
        t2 = await r2.text();
      }
      let arr = [];
      try { arr = JSON.parse(t2); } catch(e){ diag.error = "parse datos: "+(e?.message||String(e)); }
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
      diag.parseCount = feats.length;
    }catch(e){ diag.error = "datos: "+(e?.message||String(e)); }
  }

  if (feats.length){
    await writeFile(outFile, JSON.stringify({ type:"FeatureCollection", features:feats }));
  } else {
    try {
      const prev = await readFile(outFile, "utf-8");
      await writeFile(outFile, prev);
    } catch {
      await writeFile(outFile, JSON.stringify({ type:"FeatureCollection", features:[] }));
    }
  }
  await writeFile(diagFile, JSON.stringify(diag, null, 2));
  console.log("Obs: estaciones:", feats.length);
}
main().catch(e=>{ console.error(e); process.exit(0); });

