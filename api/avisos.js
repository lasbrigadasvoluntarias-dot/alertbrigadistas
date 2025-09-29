// api/avisos.js
const BASE = "https://opendata.aemet.es/opendata/api/avisos_cap";
const DESCRIPTORS = [
  `${BASE}/ultimaelaboracion/area/esp`,
  `${BASE}/ultimaelaboracion?area=esp`
];

// ----- helpers geom -----
const toNum = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
function parsePolygonString(polyStr){ const t=String(polyStr||"").trim(); if(!t)return null; const coords=[];
  if(t.includes(",")){ const pairs=t.split(/[;\s]+/).filter(Boolean);
    for(const pair of pairs){ const [latStr,lonStr]=pair.split(","); const lat=toNum(latStr),lon=toNum(lonStr); if(lat!=null&&lon!=null) coords.push([lon,lat]); }
  } else { const vals=t.split(/[;\s]+/).map(toNum).filter(v=>v!=null); for(let i=0;i+1<vals.length;i+=2) coords.push([vals[i+1],vals[i]]); }
  if(coords.length&&(coords[0][0]!==coords.at(-1)[0]||coords[0][1]!==coords.at(-1)[1])) coords.push(coords[0]);
  return coords.length>=4?coords:null;
}
function parseCircleString(circleStr){ const t=String(circleStr||"").trim(); if(!t)return null;
  const m=t.match(/(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/); if(!m) return null;
  const lat=toNum(m[1]),lon=toNum(m[2]),rkm=toNum(m[3]); if(lat==null||lon==null||rkm==null) return null;
  const R=6371,rad=rkm/R,lat0=lat*Math.PI/180,lon0=lon*Math.PI/180,steps=64,ring=[];
  for(let i=0;i<=steps;i++){ const brng=(2*Math.PI*i)/steps;
    const latp=Math.asin(Math.sin(lat0)*Math.cos(rad)+Math.cos(lat0)*Math.sin(rad)*Math.cos(brng));
    const lonp=lon0+Math.atan2(Math.sin(brng)*Math.sin(rad)*Math.cos(lat0),Math.cos(rad)-Math.sin(lat0)*Math.sin(latp));
    ring.push([lonp*180/Math.PI,latp*180/Math.PI]);
  }
  return ring;
}
function mapSeverity(info){ let sev=info?.severity||""; const ecs=Array.isArray(info?.eventCode)?info.eventCode:(info?.eventCode?[info.eventCode]:[]);
  for(const c of ecs){ const name=(c?.valueName||"").toLowerCase(); const val=(c?.value||"").toLowerCase();
    if(name.includes("awareness_level")){ if(/red|rojo|extreme|severe/.test(val)) sev||="Severe"; if(/orange|naranja|moderate/.test(val)) sev||="Moderate"; if(/yellow|amarillo|minor/.test(val)) sev||="Minor"; }
  } return sev;
}
function capToGeoJSON(cap){ const alerts=Array.isArray(cap.alert)?cap.alert:(cap.alert?[cap.alert]:[]); const features=[];
  for(const alert of alerts){ const base=(( {identifier,sender,sent,status,msgType,scope} )=>({identifier,sender,sent,status,msgType,scope}))(alert||{});
    const infos=Array.isArray(alert?.info)?alert.info:(alert?.info?[alert.info]:[]);
    for(const info of infos){ const {event,headline,description,instruction,urgency,certainty,effective,onset,expires}=info||{};
      const severity=mapSeverity(info); const areas=Array.isArray(info?.area)?info.area:(info?.area?[info.area]:[]);
      for(const a of areas){ const props={...base,event,headline,description,instruction,urgency,severity,certainty,effective,onset,expires,areaDesc:a?.areaDesc||null};
        const polys=a?.polygon?(Array.isArray(a.polygon)?a.polygon:[a.polygon]):[];
        for(const pStr of polys){ const ring=parsePolygonString(pStr); if(ring) features.push({type:"Feature",properties:props,geometry:{type:"Polygon",coordinates:[ring]}}); }
        const circles=a?.circle?(Array.isArray(a.circle)?a.circle:[a.circle]):[];
        for(const cStr of circles){ const ring=parseCircleString(cStr); if(ring) features.push({type:"Feature",properties:props,geometry:{type:"Polygon",coordinates:[ring]}}); }
      }
    }
  } return {type:"FeatureCollection",features};
}

// ----- handler -----
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    // Carga dependencias aquí (si faltan, devolvemos error legible y NO crashea)
    let XMLParser; let Agent; let agent;
    try { ({ XMLParser } = require("fast-xml-parser")); } 
    catch (e) { return res.status(500).json({ error:"MISSING_DEP", dep:"fast-xml-parser", detail:String(e?.message||e) }); }
    try { ({ Agent } = require("undici")); agent = new Agent({ connect:{ family:4, timeout: 15000 } }); } 
    catch { agent = undefined; } // si no está undici, seguimos sin forzar IPv4

    const url = new URL(req.url, "http://localhost");
    const KEY = url.searchParams.get("key") || process.env.AEMET_API_KEY;
    if (!KEY) return res.status(500).json({ error:"FALTA_API_KEY" });

    // STEP1: descriptor (probamos header y query en dos rutas)
    const tries=[];
    let desc=null;
    for (const path of DESCRIPTORS){
      // header
      try {
        const r = await fetch(path, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json", "api_key": KEY }});
        const t = await r.text();
        try { const j = JSON.parse(t); if (r.ok && j?.datos) { desc=j; break; } else tries.push({path,via:"header",status:r.status,head:t.slice(0,160)}) }
        catch { tries.push({path,via:"header",status:r.status,head:t.slice(0,160)}) }
      } catch (e) { tries.push({path,via:"header",fetch: String(e?.message||e)}) }
      // query
      try {
        const sep = path.includes("?") ? "&" : "?";
        const r = await fetch(path + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/json" }});
        const t = await r.text();
        try { const j = JSON.parse(t); if (r.ok && j?.datos) { desc=j; break; } else tries.push({path,via:"query",status:r.status,head:t.slice(0,160)}) }
        catch { tries.push({path,via:"query",status:r.status,head:t.slice(0,160)}) }
      } catch (e) { tries.push({path,via:"query",fetch: String(e?.message||e)}) }
    }
    if (!desc) return res.status(502).json({ error:"STEP1_FALLO_DESCRIPTOR", tries });

    // STEP2: descarga del CAP (con reintento añadiendo ?api_key=)
    const fetchCap = async (u) => {
      try {
        const r = await fetch(u, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/xml" }});
        const t = await r.text();
        if (r.ok && /^\s*</.test(t)) return { ok:true, t, status:r.status, withKey:false };
      } catch {}
      const sep = u.includes("?") ? "&" : "?";
      const r2 = await fetch(u + `${sep}api_key=${encodeURIComponent(KEY)}`, { cache:"no-store", dispatcher: agent, headers:{ "Accept":"application/xml" }});
      const t2 = await r2.text();
      return { ok:r2.ok && /^\s*</.test(t2), t:t2, status:r2.status, withKey:true };
    };
    const capRes = await fetchCap(desc.datos);
    if (!capRes.ok) return res.status(502).json({ error:"STEP2_FALLO_CAP", status:capRes.status, withKeySuffix:capRes.withKey, head:String(capRes.t).slice(0,200) });

    // XML → GeoJSON
    let capObj;
    try {
      const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"" });
      capObj = parser.parse(capRes.t);
    } catch (e) { return res.status(502).json({ error:"XML_INVALIDO", message:String(e?.message||e) }); }

    const geo = capToGeoJSON(capObj);
    res.setHeader("Cache-Control","public, max-age=90");
    res.setHeader("Content-Type","application/geo+json; charset=utf-8");
    return res.status(200).send(JSON.stringify(geo));
  } catch (e) {
    return res.status(500).json({ error:"FALLO_DESCONOCIDO", detail:String(e?.message||e) });
  }
};
