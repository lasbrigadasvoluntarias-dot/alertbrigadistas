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
      for(c
