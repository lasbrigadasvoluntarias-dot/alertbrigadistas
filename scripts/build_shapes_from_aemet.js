// scripts/build_shapes_from_aemet.js
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SRC_DIR = "aemet_tmp";           // carpeta donde extrajiste el tar
const OUT     = "data/emma_es.geojson";

function norm(s){
  return (s||"").normalize("NFD").replace(/\p{Diacritic}/gu,"")
           .toLowerCase().replace(/\s+/g," ").trim();
}

async function collectFeatures(dir){
  const out=[];
  async function walk(d){
    const entries = await readdir(d, { withFileTypes:true });
    for (const e of entries){
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && p.endsWith(".geojson")){
        const gj = JSON.parse(await readFile(p, "utf-8"));
        for (const f of (gj.features||[])){
          if (!f.geometry) continue;
          const props = f.properties||{};
          const name = props.nombre || props.name || props.area || props.zona || null;
          if (!name) continue;
          out.push({ name, geom:f.geometry });
        }
      }
    }
  }
  await walk(dir);
  return out;
}

const feat = await collectFeatures(SRC_DIR);

// de-duplicar por nombre normalizado
const idx = new Map();
for (const {name, geom} of feat){
  const key = norm(name);
  if (!idx.has(key)) idx.set(key, { EMMA_ID: null, name, geometry: geom });
}

// exporta como FeatureCollection
const fc = { type:"FeatureCollection", features: [] };
for (const v of idx.values()){
  fc.features.push({ type:"Feature", properties:{ EMMA_ID: v.EMMA_ID, name: v.name }, geometry: v.geometry });
}
await writeFile(OUT, JSON.stringify(fc));
console.log("Guardado", OUT, "con", fc.features.length, "features");
