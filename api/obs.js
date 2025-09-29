// api/obs.js
const API_BASE = "https://opendata.aemet.es/opendata/api/observacion/convencional/todas";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    // deps dentro del handler
    let Agent; let agent;
    try { ({ Agent } = require("undici")); agent = new Agent({ connect:{ family:4, timeout:15000 } }); }
    catch { agent = undefined; }

    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error:"FALTA_API_KEY" });

    // STEP1: descriptor
    const r1 = await fetch(`${API_BASE}?api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json" }});
    const t1 = await r1.text();
    let j; try { j = JSON.parse(t1); } catch { return res.status(502).json({ error:"STEP1_NO_JSON", status:r1.status, head:t1.slice(0,300) }); }
    if (!r1.ok) return res.status(r1.status).json({ error:"STEP1_HTTP", status:r1.status, json:j });
    if (!j?.datos) return res.status(502).json({ error:"STEP1_SIN_DATOS", json:j });

    // STEP2: datos (JSON) con reintento añadiendo api_key si hace falta
    const tryFetch = async (u) => {
      const r = await fetch(u, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json" }});
      const t = await r.text();
      return { ok: r.ok && /^\s*\[/.test(t), t, status: r.status };
    };
    let r2 = await tryFetch(j.datos);
    if (!r2.ok) {
      const sep = j.datos.includes("?") ? "&" : "?";
      r2 = await tryFetch(j.datos + `${sep}api_key=${encodeURIComponent(KEY)}`);
    }
    if (!r2.ok) return res.status(502).json({ error:"STEP2_NO_JSON", status:r2.status, head:r2.t.slice(0,300) });

    let arr; try { arr = JSON.parse(r2.t); } catch { return res.status(502).json({ error:"STEP2_PARSE_FAIL", head:r2.t.slice(0,300) }); }

    // a GeoJSON
    const feats=[];
    for (const it of arr||[]){
      const lon=Number(it.lon ?? it.longitude), lat=Number(it.lat ?? it.latitude);
      if (!Number.isFinite(lon)||!Number.isFinite(lat)) continue;
      feats.push({ type:"Feature", properties:{
        id:it.idema||it.id||null, nombre:it.ubi||it.nom||null, instante:it.fint||it.fecha||null,
        ta:it.ta??null, hr:it.hr??null, vv:it.vv??null, dv:it.dv??null, pres:it.pres??null, prec:it.prec??it.pcp??null
      }, geometry:{ type:"Point", coordinates:[lon,lat] }});
    }

    res.setHeader("Cache-Control","public, max-age=180");
    res.setHeader("Content-Type","application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify({ type:"FeatureCollection", features:feats }));
  } catch (e) {
    return res.status(500).json({ error:"FALLO_DESCONOCIDO", detail:String(e?.message||e) });
  }
};


