<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Alertas y Estaciones</title>

<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  html, body { margin:0; padding:0; height:100%; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  #map { position:absolute; inset:0; background:#f6f6f6; touch-action: none; } /* mejora gesto táctil sobre Leaflet */

  /* Controles flotantes: no capturan toques por defecto, salvo sus elementos interactivos */
  .ui { position:absolute; z-index:900; pointer-events: none; }
  .ui * { pointer-events: auto; }

  /* Estado / status */
  .status {
    top:8px; left:8px;
    background:rgba(255,255,255,.95);
    padding:4px 8px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.08);
    font-size:11px; max-width:75%;
  }

  /* Botón actualizar y botón leyenda */
  .btn, .btn-legend {
    top:8px; right:8px;
    background:rgba(255,255,255,.95);
    padding:6px 10px; border:1px solid #ddd; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.08);
    font-size:12px; cursor:pointer;
  }
  .btn-legend { right:92px; } /* coloca el botón de leyenda a la izquierda del de actualizar */

  /* Leyenda compacta + colapsable */
  .legend {
    bottom:10px; left:10px; max-width:220px;
    background:rgba(255,255,255,.95);
    padding:6px 8px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,.08);
    font-size:11px; line-height:1.25;
  }
  .legend b{ display:block; margin-bottom:4px; font-size:12px; }
  .dot{ display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  .attr{ margin-top:4px; font-size:10px; color:#666; }
  .legend.collapsed { display:none; }

  /* Oculta atribución de Leaflet/OSM */
  .leaflet-control-attribution{ display:none !important; }

  /* Responsive: en pantallas estrechas colapsa la leyenda por defecto (JS también la colapsa) */
  @media (max-width: 480px) {
    .status { max-width:65%; font-size:10px; }
    .btn, .btn-legend { font-size:11px; padding:5px 8px; }
  }
</style>
</head>
<body>
  <div id="map"></div>

  <div class="ui status" id="status">Cargando…</div>
  <button class="ui btn-legend" id="btnLegend" type="button">Leyenda</button>
  <button class="ui btn" id="btnRefresh" type="button">Actualizar</button>

  <div class="ui legend" id="legend">
    <b>Capas</b>
    <div><span class="dot" style="background:#d7191c"></span> Alerta Roja</div>
    <div><span class="dot" style="background:#fdae61"></span> Alerta Naranja</div>
    <div><span class="dot" style="background:#ffff33"></span> Alerta Amarilla</div>
    <div style="margin-top:4px"><span class="dot" style="background:#4a90e2"></span> Estaciones (temp.)</div>
    <div class="attr">Mapa © OpenStreetMap contributors</div>
  </div>

  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    // URLs publicadas (GitHub Pages)
    const ALERTAS_URL = 'https://lasbrigadasvoluntarias-dot.github.io/alertbrigadistas/avisos.geojson';
    const OBS_URL     = 'https://lasbrigadasvoluntarias-dot.github.io/alertbrigadistas/obs.geojson';

    const statusEl   = document.getElementById('status');
    const btnRefresh = document.getElementById('btnRefresh');
    const btnLegend  = document.getElementById('btnLegend');
    const legendEl   = document.getElementById('legend');

    // En móviles, empieza colapsada para no tapar el mapa
    if (window.matchMedia('(max-width: 480px)').matches) legendEl.classList.add('collapsed');
    btnLegend.addEventListener('click', () => legendEl.classList.toggle('collapsed'));

    function setStatus(s){
      const now = new Date().toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      statusEl.textContent = s + ' • ' + now;
    }
    function esc(t){ return String(t||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

    function colorSev(sev){
      const s=(sev||'').toLowerCase();
      if (s.includes('red')||s.includes('rojo')||s.includes('severe')||s.includes('extreme')) return '#d7191c';
      if (s.includes('orange')||s.includes('naranja')||s.includes('moderate')) return '#fdae61';
      if (s.includes('yellow')||s.includes('amarillo')||s.includes('minor')) return '#ffff33';
      return '#66bd63';
    }
    function colorTemp(t){
      const v=Number(t);
      if (!Number.isFinite(v)) return '#4a90e2';
      if (v >= 35) return '#b10026';
      if (v >= 30) return '#e31a1c';
      if (v >= 25) return '#fd8d3c';
      if (v >= 20) return '#feb24c';
      if (v >= 10) return '#addd8e';
      return '#2b8cbe';
    }

    // Mapa: habilita gestos táctiles explícitamente (Leaflet lo hace por defecto, pero reforzamos)
    const map = L.map('map', {
      zoomControl:true,
      attributionControl:false,
      dragging:true,
      scrollWheelZoom:true,
      touchZoom:true,
      zoom: 6,
      center: [40.3,-3.7]
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'' }).addTo(map);
    setTimeout(()=>map.invalidateSize(), 300);

    // Capas
    const layerAvisos = L.geoJSON(null, {
      style: f => ({ color:'#333', weight:1, fillOpacity:.5, fillColor: colorSev(f.properties?.severity || f.properties?.nivel) }),
      onEachFeature: (f, l) => {
        const p=f.properties||{};
        const head=p.headline||p.event||'Aviso';
        const zona=p.areaDesc||p.area||p.EMMA_ID||'—';
        const sev=p.severity||p.nivel||'—';
        const val=(p.onset||'—')+' → '+(p.expires||'—');
        const desc=p.description?`<hr style="border:none;border-top:1px solid #ddd;margin:6px 0">${esc(p.description)}`:'';
        const instr=p.instruction?`<div style="margin-top:6px"><b>Indicaciones:</b> ${esc(p.instruction)}</div>`:'';
        l.bindPopup(`<b>${esc(head)}</b><br><b>Zona:</b> ${esc(zona)}<br><b>Severidad:</b> ${esc(sev)}<br><b>Validez:</b> ${esc(val)}${desc}${instr}`);
      }
    }).addTo(map);

    const layerObs = L.layerGroup();
    L.control.layers({}, { "Alertas": layerAvisos, "Estaciones (temp)": layerObs }, { collapsed:true }).addTo(map);

    async function cargarAvisos(){
      setStatus('Cargando alertas…');
      try{
        const r = await fetch(ALERTAS_URL + '?t=' + Date.now(), { cache:'no-store' });
        if (!r.ok){ setStatus('Error alertas ' + r.status); return; }
        const geo = await r.json();
        layerAvisos.clearLayers();
        if (geo?.features?.length){
          layerAvisos.addData(geo);
          try { map.fitBounds(layerAvisos.getBounds(), { padding:[18,18] }); } catch(e){}
        }
        setStatus(`Alertas: ${geo?.features?.length || 0}`);
      }catch(e){ setStatus('Error alertas: ' + String(e).slice(0,100)); }
    }

    async function cargarObs(){
      setStatus('Cargando estaciones…');
      try{
        const r = await fetch(OBS_URL + '?t=' + Date.now(), { cache:'no-store' });
        if (!r.ok){ setStatus('Error estaciones ' + r.status); return; }
        const geo = await r.json();
        layerObs.clearLayers();
        (geo?.features||[]).forEach(f=>{
          const p=f.properties||{}, [lon,lat]=f.geometry?.coordinates||[];
          if (!Number.isFinite(lon)||!Number.isFinite(lat)) return;
          const marker = L.circleMarker([lat,lon], { radius: 5, color:'#222', weight:1, fillColor: colorTemp(p.ta), fillOpacity:.85 });
          const viento = (p.vv!=null? `${p.vv} m/s` : '—') + (p.dv!=null? ` (${p.dv}°)` : '');
          marker.bindPopup(`<b>${esc(p.nombre||p.id||'Estación')}</b><br><b>Instante:</b> ${esc(p.instante||'—')}<br><b>Temp.:</b> ${p.ta!=null? esc(p.ta)+' °C':'—'}<br><b>Humedad:</b> ${p.hr!=null? esc(p.hr)+' %':'—'}<br><b>Viento:</b> ${esc(viento)}<br><b>Presión:</b> ${p.pres!=null? esc(p.pres)+' hPa':'—'}<br><b>Precip.:</b> ${p.prec!=null? esc(p.prec)+' mm':'—'}`);
          layerObs.addLayer(marker);
        });
        setStatus(`Estaciones: ${geo?.features?.length || 0}`);
      }catch(e){ setStatus('Error estaciones: ' + String(e).slice(0,100)); }
    }

    async function cargarTodo(){ await Promise.all([cargarAvisos(), cargarObs()]); }
    btnRefresh.addEventListener('click', cargarTodo);

    // primer render + refresco automático cada 5 min
    cargarTodo();
    setInterval(cargarTodo, 5*60*1000);
  </script>
</body>
</html>
