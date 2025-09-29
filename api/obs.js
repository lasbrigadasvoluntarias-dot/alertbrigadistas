// api/obs.js
// Node 18+
const API_BASE = "https://opendata.aemet.es/opendata/api/observacion/convencional/todas";

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error: "FALTA_API_KEY" });

    // Paso 1: descriptor (JSON con {datos,...})
    const r1 = await fetch(`${API_BASE}?api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", headers:{ "Accept":"application/json" }});
    const t1 = await r1.text();
    let j;
    try { j = JSON.parse(t1); } catch { return res.status(502).json({ error:"STEP1_NO_JSON", status:r1.status, head:t1.slice(0,300) }); }
    if (!r1.ok) return res.status(r1.status).json({ error:"STEP1_HTTP", status:r1.status, json:j });
    if (!j?.datos) return res.status(502).json({ error:"STEP1_SIN_DATOS", json:j });

    // Paso 2: descarga de datos (JSON grande con objetos de estaciones)
    const r2 = await fetch(j.datos, { cache:"no-store", headers:{ "Accept":"application/json" }});
    const t2 = await r2.text();
    let arr;
    try { arr = JSON.parse(t2); } catch {
      // reintento forzando ?api_key= por si el enlace lo exige
      const sep = j.datos.includes("?") ? "&" : "?";
      const r2b = await fetch(j.datos + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", headers:{ "Accept":"application/json" }});
      const t2b = await r2b.text();
      try { arr = JSON.parse(t2b); } catch { return res.status(502).json({ error:"STEP2_NO_JSON", head: (t2b||t2).slice(0,300) }); }
    }

    // Construye GeoJSON (algunos campos típicos: idema, lon, lat, fint, ta, hr, vv, dv, pres, prec)
    const feats = [];
    for (const it of arr || []) {
      const lon = Number(it.lon ?? it.longitude);
      const lat = Number(it.lat ?? it.latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const props = {
        id: it.idema || it.id || null,
        nombre: it.ubi || it.nom || null,
        instante: it.fint || it.fecha || null,
        ta: it.ta ?? null,      // temperatura
        hr: it.hr ?? null,      // humedad relativa
        vv: it.vv ?? null,      // viento (m/s)
        dv: it.dv ?? null,      // dirección (grados)
        pres: it.pres ?? null,  // presión
        prec: it.prec ?? it.pcp ?? null // precipitación (mm)
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
