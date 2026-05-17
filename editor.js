(function(){'use strict';

// ── State ──────────────────────────────────────────────────
var map, osmLayer, satLayer, labels, latlngs, trackLine;
var descOverlay = null;
var removals = [], selStart = null, selEnd = null, selMarkers = [], removedLines = [];
var rawData = [];
var dragCounter = 0;
var fileMeta = {};
var trackInfo = {};
var points = [];
var _distCache = {total: null, effective: null};
var waypoints = [];
var wpGroup;
var wpVisible = true;
var trackVisible = true;
var wpDeleted = [];
var wpEdited = {};

// ── Delegated event hub ────────────────────────────────────
// Replaces ALL inline onclick="..." with safe data-action attributes
document.addEventListener('click',function(e){
  var btn = e.target.closest('[data-action]');
  if (!btn) return;
  var a = btn.dataset.action;
  if (a === 'start-rename')      startRename();
  else if (a === 'show-desc')    showTrackDesc();
  else if (a === 'toggle-track') toggleTrack();
  else if (a === 'toggle-wp')    toggleWaypoints();
  else if (a === 'edit-wp')      editWp(+btn.dataset.idx);
  else if (a === 'delete-wp')    deleteWp(+btn.dataset.idx);
  else if (a === 'confirm-del')  { map&&map.closePopup(); confirmDelete(); }
  else if (a === 'clear-sel')    { map&&map.closePopup(); clearSel(); }
  else if (a === 'undo-del')     undoDelete(+btn.dataset.idx);
  else if (a === 'highlight-del'){ var r=removals[+btn.dataset.idx]; if(r) highlightRange(r.start,r.end); }
});

// ── Helpers ────────────────────────────────────────────────
function isClickOnUI(oe){ return oe&&oe.target&&(document.getElementById('panel').contains(oe.target)||document.getElementById('mapTools').contains(oe.target)); }

document.getElementById('panel').addEventListener('wheel',function(e){e.stopPropagation()},{passive:true});

// ── Data Loading ───────────────────────────────────────────
var tiP=fetch('/track_info.json').then(function(r){return r.json()}).catch(function(){return{}});
var mtP=fetch('/upload_meta.json').then(function(r){return r.json()}).catch(function(){return{}});
var dtP=fetch('/track_data.json').then(function(r){return r.json()}).catch(function(){return[]});
var wpP=fetch('/waypoints.json').then(function(r){return r.json()}).catch(function(){return[]});

Promise.all([tiP,mtP,dtP,wpP]).then(function(a){
  trackInfo=a[0]; fileMeta=a[1]; waypoints=a[3];
  loadWpEdits(); renderWaypoints();
  var d=a[2];
  if(d&&d.length){ rawData=d; points=d.map(function(p){return{idx:p[0],lat:p[1],lng:p[2],alt:p[3],time:p[4]}}); }
  else { console.warn('No track data'); points=[]; }
  initEditor();
});

// ── Haversine ──────────────────────────────────────────────
function rad(d){return d*Math.PI/180}
function computeDistance(data){
  if(data.length<2)return 0;
  var t=0;
  for(var i=1;i<data.length;i++){
    var p1=data[i-1],p2=data[i];
    var a=Math.sin(rad(p2[1]-p1[1])/2)*Math.sin(rad(p2[1]-p1[1])/2)+Math.cos(rad(p1[1]))*Math.cos(rad(p2[1]))*Math.sin(rad(p2[2]-p1[2])/2)*Math.sin(rad(p2[2]-p1[2])/2);
    t+=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  return t;
}
function computeEffectiveDistance(data,removals){
  if(data.length<2)return 0;
  var t=0;
  for(var i=1;i<data.length;i++){
    var del=false;
    for(var j=0;j<removals.length;j++){if(i>=removals[j].start&&i<=removals[j].end){del=true;break}}
    if(del)continue;
    var p1=data[i-1],p2=data[i];
    var a=Math.sin(rad(p2[1]-p1[1])/2)*Math.sin(rad(p2[1]-p1[1])/2)+Math.cos(rad(p1[1]))*Math.cos(rad(p2[1]))*Math.sin(rad(p2[2]-p1[2])/2)*Math.sin(rad(p2[2]-p1[2])/2);
    t+=6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
  }
  return t;
}
function getCachedDist(){if(_distCache.total===null)_distCache.total=computeDistance(rawData);return _distCache.total}
function getCachedEffectiveDist(){if(_distCache.effective===null)_distCache.effective=computeEffectiveDistance(rawData,removals);return _distCache.effective}
function invalidateDistCache(){_distCache.total=null;_distCache.effective=null}

// ── UI Helpers ─────────────────────────────────────────────
function fitBoundsWithPanel(b,p){
  var pw=(document.getElementById('panel')||{}).offsetWidth||300;
  var pad=p||30;
  map.fitBounds(b,{paddingTopLeft:[pad,pad],paddingBottomRight:[pad+pw,pad]});
}
function formatDate(iso){
  if(!iso)return'';
  var d=new Date(iso);
  return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);
}
function escHtml(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}

function showDropZone(){var dz=document.getElementById('dropZone');if(dz)dz.classList.add('active')}
function hideDropZone(){var dz=document.getElementById('dropZone');if(dz)dz.classList.remove('active')}
function setDropZonePersistent(s){
  var dz=document.getElementById('dropZone');
  if(!dz)return;
  if(s)dz.classList.add('permanent');
  else{dz.classList.remove('permanent');dz.classList.remove('active')}
}

// ── File Info ──────────────────────────────────────────────
function renderFileInfo(){
  var el=document.getElementById('fileInfo');
  if(!el)return;
  if(points.length===0){el.innerHTML='<div class="placeholder"><span class="icon">📂</span>暂无轨迹<br>拖放 KMZ 文件到地图</div>';return}
  var name=fileMeta.displayName||fileMeta.name||'轨迹';
  if(name.endsWith('.kmz'))name=name.slice(0,-4);
  var date=formatDate(points[0].time);
  var dist=getCachedDist();
  var ds=dist>=1000?(dist/1000).toFixed(1)+' km':dist.toFixed(0)+' m';
  var wpT=waypoints.length,wpE=wpT-wpDeleted.length,wpHE=wpDeleted.length>0;
  var rPts=points.length-removals.reduce(function(a,r){return a+r.end-r.start+1},0);
  var rD=getCachedEffectiveDist();
  var rDs=rD>=1000?(rD/1000).toFixed(1)+' km':rD.toFixed(0)+' m';
  var he=removals.length>0;

  el.innerHTML=
    '<div class="fi-header">'+
      '<div class="name" id="trackName">'+
        '<span data-action="start-rename" style="cursor:pointer" title="点击修改名称">'+escHtml(name)+'</span>'+
        (he?'<span class="edited-badge">已编辑</span>':'')+
        '<svg data-action="start-rename" style="cursor:pointer;opacity:0.3;margin-left:6px;vertical-align:middle" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>'+
      '</div>'+
      (trackInfo.desc?'<span data-action="show-desc" class="fi-info"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg></span>':'')+
    '</div>'+
    '<div class="sub">'+date+'</div>'+
    '<div class="fl-section">'+
      '<div class="fl-header"><span class="fl-label">轨迹</span><span data-action="toggle-track" class="eye-btn">'+(trackVisible?'👁':'👁‍🗨')+'</span></div>'+
      '<div class="fl-row"><span class="fl-key">长度</span><span class="fl-val">'+(he?'<s>'+ds+'</s> <em class="ev">'+rDs+'</em>':ds)+'</span></div>'+
      '<div class="fl-row"><span class="fl-key">点数</span><span class="fl-val">'+(he?'<s>'+points.length.toLocaleString()+'</s> <em class="ev">'+rPts.toLocaleString()+'</em>':points.length.toLocaleString())+'</span></div>'+
    '</div>'+
    '<div class="fl-section">'+
      '<div class="fl-header"><span class="fl-label">标注点</span><span data-action="toggle-wp" class="eye-btn">'+(wpVisible?'👁':'👁‍🗨')+'</span></div>'+
      '<div class="fl-row"><span class="fl-key">数量</span><span class="fl-val">'+(wpHE?'<s>'+wpT+'</s> <em class="ev">'+wpE+'</em>':wpT)+'</span></div>'+
    '</div>';
}

// ── Rename ────────────────────────────────────────────────
function startRename(){
  var c=fileMeta.displayName||fileMeta.name||'轨迹';
  if(c.endsWith('.kmz'))c=c.slice(0,-4);
  var ne=document.getElementById('trackName');if(!ne)return;
  var inp=document.createElement('input');
  inp.type='text';inp.value=c;
  inp.style.cssText='background:var(--canvas);border:1px solid var(--coral);color:var(--ink);font-size:20px;font-weight:700;padding:4px 8px;border-radius:6px;width:100%;outline:none;';
  inp.autofocus=true;ne.innerHTML='';ne.appendChild(inp);inp.focus();inp.select();
  function sub(){
    var v=inp.value.trim();
    if(!v){inp.focus();return}
    fetch('/api/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:v})})
    .then(function(r){return r.json()}).then(function(d){if(d.success)fileMeta.displayName=d.name;renderFileInfo()})
    .catch(function(){renderFileInfo()});
  }
  function cancel(){renderFileInfo()}
  inp.addEventListener('blur',cancel);
  inp.addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();sub()}
    if(e.key==='Escape')cancel();
  });
}

// ── Track Description Overlay ──────────────────────────────
function showTrackDesc(){
  if(!trackInfo.desc)return;
  if(descOverlay){document.body.removeChild(descOverlay);descOverlay=null;return}
  var ov=document.createElement('div');
  ov.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;z-index:5000;background:rgba(15,23,42,0.6);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center';
  ov.onclick=function(){document.body.removeChild(ov);descOverlay=null};
  var bx=document.createElement('div');
  bx.style.cssText='background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:420px;width:90%;color:var(--body);font-size:13px;line-height:1.8;box-shadow:0 8px 32px rgba(0,0,0,0.5)';
  bx.onclick=function(e){e.stopPropagation()};
  var hdr=document.createElement('div');
  hdr.style.cssText='display:flex;align-items:center;justify-content:space-between;margin-bottom:12px';
  var ht=document.createElement('span');ht.style.cssText='font-size:14px;font-weight:600;color:var(--ink)';ht.textContent='路线介绍';
  var hc=document.createElement('span');hc.style.cssText='cursor:pointer;color:var(--muted);font-size:16px';
  hc.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  hc.onclick=function(){document.body.removeChild(ov);descOverlay=null};
  hdr.appendChild(ht);hdr.appendChild(hc);bx.appendChild(hdr);
  var bb=document.createElement('div');bb.style.color='var(--body)';bb.textContent=trackInfo.desc;
  bx.appendChild(bb);ov.appendChild(bx);document.body.appendChild(ov);descOverlay=ov;
}

// ── Layer Visibility ──────────────────────────────────────
function toggleLayer(l){if(!l)return;if(map.hasLayer(l)){map.removeLayer(l);return false}map.addLayer(l);return true}
function toggleWaypoints(){if(!wpGroup)return;wpVisible=toggleLayer(wpGroup);renderFileInfo()}
function toggleTrack(){
  if(!trackLine)return;
  trackVisible=!trackVisible;
  if(trackVisible)map.addLayer(trackLine);
  else{map.removeLayer(trackLine);if(hoverDot){hoverDot.setLatLng([0,0]);hoverIdx=-1}map.getContainer().style.cursor=''}
  renderFileInfo();
}

// ── Waypoints ─────────────────────────────────────────────
function saveWpEdits(){localStorage.setItem('trackEditor_wpEdits',JSON.stringify({deleted:wpDeleted,edited:wpEdited}))}
function loadWpEdits(){
  var s=localStorage.getItem('trackEditor_wpEdits');
  if(s)try{var d=JSON.parse(s);wpDeleted=d.deleted||[];wpEdited=d.edited||{}}catch(e){}
}
function deleteWp(idx){
  if(idx<0||idx>=waypoints.length)return;
  if(!wpDeleted.includes(idx))wpDeleted.push(idx);
  saveWpEdits();map&&map.closePopup();renderWaypoints();renderFileInfo();
}
function editWp(idx){
  if(idx<0||idx>=waypoints.length)return;
  var wp=waypoints[idx],ex=wpEdited[idx]||{};
  var name=prompt('编辑标注点名称：',ex.name||wp.name);
  if(name===null)return;
  wpEdited[idx]={name:name};saveWpEdits();map&&map.closePopup();renderWaypoints();renderFileInfo();
}
function renderWaypoints(){
  if(waypoints.length===0||!map)return;
  if(wpGroup)map.removeLayer(wpGroup);
  wpGroup=L.layerGroup().addTo(map);if(!wpVisible)map.removeLayer(wpGroup);
  for(var i=0;i<waypoints.length;i++){
    if(wpDeleted.includes(i))continue;
    var w=waypoints[i],wn=(wpEdited[i]&&wpEdited[i].name)||w.name;
    var m=L.marker([w.lat,w.lng],{icon:L.divIcon({className:'wp-icon',html:'<div class="wp-diamond"></div>',iconSize:[16,16],iconAnchor:[8,8]})});
    m.bindTooltip(escHtml(wn),{sticky:true});
    m.on('click',(function(w,idx,wn){
      return function(){
        var h='<div class="wp-popup"><h3 style="margin:0;font-size:14px;color:var(--ink);font-weight:600;text-align:center">'+escHtml(wn)+'</h3>';
        if(w.desc)h+='<div class="desc" style="margin-top:6px">'+w.desc.replace(/<img /gi,'<img style="max-width:100%;max-height:260px;object-fit:contain" loading="lazy" ').replace(/<embed[^>]+src="([^"]+)"[^>]*>/gi,'<video controls style="max-width:100%;max-height:260px;border-radius:6px;margin:4px 0" preload="metadata"><source src="/$1"></video>')+'</div>';
        h+='<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border);display:flex;gap:6px">'+
          '<button data-action="edit-wp" data-idx="'+idx+'" style="flex:1;background:var(--border);color:var(--ink);border:none;border-radius:999px;padding:4px 0;font-size:11px;cursor:pointer;font-weight:500">编辑名称</button>'+
          '<button data-action="delete-wp" data-idx="'+idx+'" style="flex:1;background:var(--coral);color:#fff;border:none;border-radius:999px;padding:4px 0;font-size:11px;cursor:pointer;font-weight:500">删除</button>'+
        '</div></div>';
        this.unbindTooltip();this.bindPopup(h,{maxWidth:380,minWidth:280}).openPopup();
      };
    })(w,i,wn));
    m.addTo(wpGroup);
  }
}

// ── Deletion List ─────────────────────────────────────────
function refreshDelList(){
  var el=document.getElementById('removalsList'),ft=document.getElementById('delFooter'),ce=document.getElementById('delCount');
  if(removals.length===0){el.innerHTML='<div class="empty">尚未删除任何路径</div>';if(ft)ft.style.display='none';return}
  if(ft)ft.style.display='flex';if(ce)ce.textContent='已删除 '+removals.length+' 段';
  var h='';
  for(var i=removals.length-1;i>=0;i--){var r=removals[i];
    h+='<div class="item"><span data-action="highlight-del" data-idx="'+i+'" class="label" style="cursor:pointer">#'+r.start+'→#'+r.end+' ('+(r.end-r.start+1)+')</span><button data-action="undo-del" data-idx="'+i+'" class="remove">✕</button></div>'}
  el.innerHTML=h;
}
function undoDelete(idx){
  var r=removals[idx];removals.splice(idx,1);
  localStorage.setItem('trackEditor_removals',JSON.stringify(removals));
  for(var i=0;i<removedLines.length;i++){if(removedLines[i]._delInfo&&removedLines[i]._delInfo.start===r.start&&removedLines[i]._delInfo.end===r.end){map.removeLayer(removedLines[i]);removedLines.splice(i,1);break}}
  invalidateDistCache();refreshDelList();renderFileInfo();
}
function clearAllDeletions(){
  if(removals.length===0)return;
  for(var i=0;i<removedLines.length;i++)map.removeLayer(removedLines[i]);
  removedLines=[];removals=[];invalidateDistCache();localStorage.removeItem('trackEditor_removals');refreshDelList();renderFileInfo();
}
function highlightRange(s,e){
  if(window._hlLine)map.removeLayer(window._hlLine);
  window._hlLine=L.polyline(latlngs.slice(s,e+1),{color:'#fbbf24',weight:8,opacity:0.9}).addTo(map);
  fitBoundsWithPanel(window._hlLine.getBounds());
  setTimeout(function(){if(window._hlLine){map.removeLayer(window._hlLine);window._hlLine=null}},3000);
}
function confirmDelete(){
  if(selStart===null||selEnd===null)return;
  var s=Math.min(selStart,selEnd),e=Math.max(selStart,selEnd);
  removals.push({start:s,end:e});localStorage.setItem('trackEditor_removals',JSON.stringify(removals));
  invalidateDistCache();
  var rl=L.polyline(latlngs.slice(s,e+1),{color:'#6b7280',weight:5,opacity:0.5}).addTo(map);removedLines.push(rl);rl._delInfo={start:s,end:e};
  clearSel();refreshDelList();renderFileInfo();
}

// ── Selection ─────────────────────────────────────────────
var hoverDot,hoverIdx=-1,_hoverLast=0;

function clearSel(){
  selStart=null;selEnd=null;
  selMarkers.forEach(function(x){map.removeLayer(x)});selMarkers=[];
  map&&map.closePopup();
}
function updateSel(){
  selMarkers.forEach(function(x){map.removeLayer(x)});selMarkers=[];
  if(selStart!=null&&selEnd!=null){
    var s=Math.min(selStart,selEnd),e=Math.max(selStart,selEnd);
    var sl=L.polyline(latlngs.slice(s,e+1),{color:'#facc15',weight:6,opacity:0.9}).addTo(map);selMarkers.push(sl);
    var m1=L.circleMarker([points[s].lat,points[s].lng],{radius:8,color:'#facc15',fill:true,fillColor:'#facc15',fillOpacity:1,weight:2}).addTo(map);m1.bindTooltip('#'+s);selMarkers.push(m1);
    var m2=L.circleMarker([points[e].lat,points[e].lng],{radius:8,color:'#facc15',fill:true,fillColor:'#facc15',fillOpacity:1,weight:2}).addTo(map);m2.bindTooltip('#'+e);selMarkers.push(m2);
    fitBoundsWithPanel(sl.getBounds());
  } else if(selStart!=null){
    var m=L.circleMarker([points[selStart].lat,points[selStart].lng],{radius:8,color:'#f59e0b',fill:true,fillColor:'#f59e0b',fillOpacity:1,weight:2}).addTo(map);m.bindTooltip('#'+selStart);selMarkers.push(m);
  }
}
function showInfo(i){
  L.popup({closeButton:true,maxWidth:300}).setLatLng([points[i].lat,points[i].lng]).setContent(
    '<div style="font-size:12px;line-height:1.6"><b>#'+i+'</b><br>时间: '+escHtml(points[i].time)+'<br>纬度: '+points[i].lat.toFixed(6)+'<br>经度: '+points[i].lng.toFixed(6)+'<br>海拔: '+points[i].alt+'m<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px"><button data-action="clear-sel" style="background:var(--border);border:none;color:var(--ink);border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer">取消</button></div></div>'
  ).openOn(map);
}
function updateSelInfo(s,e){
  if(s===null||e===null)return;
  var st=Math.min(s,e),en=Math.max(s,e),cnt=en-st+1,p1=points[st],p2=points[en];
  L.popup({closeButton:true,maxWidth:300}).setLatLng([(p1.lat+p2.lat)/2,(p1.lng+p2.lng)/2]).setContent(
    '<div style="font-size:12px;line-height:1.6"><b>#'+st+' → #'+en+'</b><br>'+cnt+' 个点<br>起点: '+p1.lat.toFixed(5)+', '+p1.lng.toFixed(5)+'<br>终点: '+p2.lat.toFixed(5)+', '+p2.lng.toFixed(5)+'<br><div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;display:flex;gap:6px"><button data-action="confirm-del" style="background:var(--coral);color:#fff;border:none;border-radius:999px;padding:4px 14px;font-size:11px;cursor:pointer;font-weight:500">删除</button><button data-action="clear-sel" style="background:var(--surface-soft);border:1px solid var(--border);color:var(--ink);border-radius:999px;padding:4px 14px;font-size:11px;cursor:pointer;font-weight:500">重置</button></div></div>'
  ).openOn(map);
}
function nearestLL(latlng){
  if(points.length===0)return null;
  var d=Infinity,n=null,th=60;
  for(var i=0;i<points.length;i++){var di=map.distance(latlng,[points[i].lat,points[i].lng]);if(di<d){d=di;n=i}}
  return d<=th?n:null;
}

// ── Main Init ─────────────────────────────────────────────
function initEditor(){
  // Restore from localStorage
  var s=localStorage.getItem('trackEditor_removals');
  if(s)try{removals=JSON.parse(s)}catch(e){}

  // Map with Canvas renderer (much faster for many vectors)
  map=L.map('map',{zoomControl:false,maxZoom:20,attributionControl:false,preferCanvas:true});
  L.control.zoom({position:'topleft',zoomInTitle:'放大地图',zoomOutTitle:'缩小地图'}).addTo(map);

  osmLayer=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'OSM',maxZoom:20});
  satLayer=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{attribution:'Esri',maxZoom:20,maxNativeZoom:17});
  labels=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',{attribution:'Esri',maxZoom:20,maxNativeZoom:17});
  satLayer.addTo(map);labels.addTo(map);

  // Layer switch
  document.getElementById('mapSwitch').addEventListener('click',function(e){
    var btn=e.target.closest('button');
    if(!btn||!btn.dataset.map)return;
    this.querySelectorAll('button').forEach(function(b){b.classList.remove('active')});
    btn.classList.add('active');
    if(btn.dataset.map==='satellite'){map.removeLayer(osmLayer);satLayer.addTo(map);labels.addTo(map);if(trackLine)trackLine.setStyle({color:'#00f5d4'})}
    else{map.removeLayer(satLayer);map.removeLayer(labels);osmLayer.addTo(map);if(trackLine)trackLine.setStyle({color:'#2563eb'})}
  });

  // Track data
  if(points.length>0){
    latlngs=points.map(function(p){return[p.lat,p.lng]});
    trackLine=L.polyline(latlngs,{color:'#00f5d4',weight:5,opacity:0.8}).addTo(map);
    wpGroup=L.layerGroup().addTo(map);
  } else latlngs=[];

  // Interaction
  if(points.length>0){
    trackLine.on('click',function(e){
      if(isClickOnUI(e.originalEvent))return;
      if(selStart!==null&&selEnd!==null){updateSelInfo(selStart,selEnd);return}
      var i=nearestLL(e.latlng);if(i!=null)showInfo(i);
    });
    map.on('click',function(e){
      if(isClickOnUI(e.originalEvent))return;
      if(!trackVisible)return;
      var i=nearestLL(e.latlng);if(i==null)return;
      if(selStart==null){selStart=i;showInfo(i)}
      else if(selEnd==null&&selStart!=null){
        if(i===selStart){selStart=null;clearSel()}
        else{selEnd=i;updateSelInfo(selStart,selEnd)}
      }
      updateSel();
    });
    hoverDot=L.circleMarker([0,0],{radius:7,color:'#fff',fill:true,fillColor:'#00f5d4',fillOpacity:0.9,weight:2}).addTo(map);
    hoverDot.bindTooltip('',{sticky:true});
    map.on('mousemove',function(e){
      if(!trackVisible){if(hoverIdx!==-1){hoverDot.setLatLng([0,0]);hoverIdx=-1;map.getContainer().style.cursor=''}return}
      var now=Date.now();if(now-_hoverLast<100)return;_hoverLast=now;
      if(isClickOnUI(e.originalEvent)){if(hoverIdx!==-1){hoverDot.setLatLng([0,0]);hoverIdx=-1;map.getContainer().style.cursor=''}return}
      var idx=nearestLL(e.latlng);
      if(idx!==null&&idx!==hoverIdx){hoverIdx=idx;hoverDot.setLatLng([points[idx].lat,points[idx].lng]);hoverDot.setTooltipContent('#'+idx);map.getContainer().style.cursor='pointer'}
      else if(idx===null&&hoverIdx!==-1){hoverDot.setLatLng([0,0]);hoverIdx=-1;map.getContainer().style.cursor=''}
    });
  }

  // Reset view
  new(L.Control.extend({onAdd:function(){
    var btn=L.DomUtil.create('button','leaflet-control-reset');
    btn.innerHTML='⟲';btn.title='重置地图视图';
    btn.style.cssText='width:30px;height:30px;background:var(--surface);color:var(--ink);border:2px solid var(--border);cursor:pointer;font-size:18px;font-weight:bold;line-height:30px;text-align:center;padding:0;margin-top:4px;border-radius:2px';
    L.DomEvent.on(btn,'click',function(e){L.DomEvent.stopPropagation(e);if(trackLine)fitBoundsWithPanel(trackLine.getBounds())});
    return btn;
  }}))({position:'topleft'}).addTo(map);

  if(points.length>0){fitBoundsWithPanel(trackLine.getBounds());setDropZonePersistent(false)}
  else{map.setView([35,110],4);setDropZonePersistent(true)}

  renderFileInfo();refreshDelList();renderWaypoints();

  // ── Drag & Drop ────────────────────────────────────────────
  (function setupDragDrop(){
    var dz=document.getElementById('dropZone'),mapEl=document.getElementById('map');
    if(!dz||!mapEl)return;
    mapEl.addEventListener('dragenter',function(e){e.preventDefault();e.stopPropagation();dragCounter++;showDropZone()});
    mapEl.addEventListener('dragover',function(e){e.preventDefault();e.stopPropagation()});
    mapEl.addEventListener('dragleave',function(e){e.preventDefault();e.stopPropagation();dragCounter--;if(dragCounter<=0){dragCounter=0;hideDropZone()}});
    mapEl.addEventListener('drop',function(e){
      e.preventDefault();e.stopPropagation();dragCounter=0;hideDropZone();
      var files=e.dataTransfer&&e.dataTransfer.files;
      if(!files||files.length===0)return;
      var file=files[0];
      if(!file.name||!file.name.toLowerCase().endsWith('.kmz')){alert('请拖放 .kmz 格式的文件');return}
      var ov=document.getElementById('overlay');
      document.getElementById('overlayText').textContent='正在上传 '+file.name+' ...';
      ov.style.display='flex';
      var fd=new FormData();fd.append('file',file);
      fetch('/upload',{method:'POST',body:fd}).then(function(r){return r.json()}).then(function(d){
        if(d.success){
          document.getElementById('overlayText').textContent='加载完成，正在刷新...';
          localStorage.removeItem('trackEditor_removals');
          localStorage.removeItem('trackEditor_wpEdits');
          setTimeout(function(){location.reload()},800);
        } else {
          ov.style.display='none';
          alert('上传失败: '+(d.error||'未知错误'));
        }
      }).catch(function(e){ov.style.display='none';alert('上传失败: '+e.message)});
    });
  })();
}

// ── Export / Download ──────────────────────────────────────
document.getElementById('btnDownload').onclick=function(){
  var btn=this;if(btn.disabled)return;btn.disabled=true;
  var ov=document.getElementById('overlay');
  document.getElementById('overlayText').textContent='正在处理 '+removals.length+' 个删除范围...';ov.style.display='flex';
  fetch('/api/apply-edits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({removals:removals,totalPts:points.length,wpDeleted:wpDeleted,wpEdited:wpEdited})})
  .then(function(r){return r.json()}).then(function(d){
    ov.style.display='none';btn.disabled=false;
    if(d.success){var a=document.createElement('a');a.href=(d.downloadUrl||'/download/track_edited.kmz')+'?t='+Date.now();a.download='';a.style.display='none';document.body.appendChild(a);a.click();document.body.removeChild(a)}
    else alert('编辑失败: '+(d.error||'未知错误'));
  }).catch(function(e){ov.style.display='none';btn.disabled=false;alert('导出失败: '+e.message)});
};
document.getElementById('btnClear').onclick=clearAllDeletions;

})();
