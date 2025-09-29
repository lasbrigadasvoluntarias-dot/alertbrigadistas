// api/obs.js
const { Agent } = require("undici");
const agent = new Agent({ connect: { family: 4, timeout: 15_000 } });

const API_BASE = "https://opendata.aemet.es/opendata/api/observacion/convencional/todas";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error: "FALTA_API_KEY" });

    const step1 = await fetch(`${API_BASE}?api_key=${encodeURIComponent(KEY)}`, {
      cache: "no-store",
      dispatcher: agent,
      headers: { "Accept":"application/json", "User-Agent":"alertbrigadistas/1.0" }
    }).then(r => r.text());

    let j; try { j = JSON.parse(step1); } catch { return res.status(502).json({ error:"STEP1_NO_JSON", head: step1.slice(0,300) }); }
    if (!j?.datos) return res.status(502).json({ error:"STEP1_SIN_DATOS", json:j });

    // descarga datos (JSON). Si falla, reintenta añadiendo ?api_key
    let dataTxt, r2 = await fetch(j.datos, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json", "User-Agent":"alertbrigadistas/1.0" }});
    dataTxt = await r2.text();
    if (!r2.ok || !/^\s*\[/.test(dataTxt)) {
      const sep = j.datos.includes("?") ? "&" : "?";
      r2 = await fetch(j.datos + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json", "User-Agent":"alertbrigadistas/1.0" }});
      dataTxt = await r2.text();
    }
    let arr; try { arr = JSON.parse(dataTxt); } catch { return res.status(502).json({ error:"STEP2_NO_JSON", head: dataTxt.slice(0,300) }); }

    const feats = [];
    for (const it of arr || []) {
      const lon = Number(it.lon ?? it.longitude), lat = Number(it.lat ?? it.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const props = {
        id: it.idema || it.id || null, nombre: it.ubi || it.nom || null, instante: it.fint || it.fecha || null,
        ta: it.ta ?? null, hr: it.hr ?? null, vv: it.vv ?? null, dv: it.dv ?? null, pres: it.pres ?? null, prec: it.prec ?? it.pcp ?? null
      };
      feats.push({ type:"Feature", properties: props, geometry:{ type:"Point", coordinates:[lon, lat] }});
    }

    res.setHeader("Cache-Control","public, max-age=180");
    res.setHeader("Content-Type","application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify({ type:"FeatureCollection", features: feats }));
  } catch (e) {
    return res.status(500).json({ error:"FALLO_DESCONOCIDO", detail:String(e?.message||e) });
  }
};

