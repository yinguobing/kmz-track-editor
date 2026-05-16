function updateStats() {
  document.getElementById('totalPts').textContent = P.length;
  var d = rv.reduce(function(a, r) { return a + r.end - r.start + 1; }, 0);
  document.getElementById('delPts').textContent = d;
  document.getElementById('finalPts').textContent = P.length - d;
}

var trackName = "两步路轨迹编辑器";
// Global vars for map state - assigned in initEditor
var mm, osm, sat, labels, activeLabels, pts, pl;
var rv = [], ss = null, se = null, sm = [], removedLines = [];
var clearSel;
var DATA = [];  // loaded from track_data.json
var dragCounter = 0;
var fileMeta = {};  // name from upload_meta.json

var P = [];

// Load file metadata (original filename)
fetch('/upload_meta.json').then(function(r){return r.json();}).then(function(d){
  fileMeta = d;
  // Re-render file info in case it was rendered before meta loaded
  renderFileInfo();
}).catch(function(){});

// Load track data from JSON
fetch('/track_data.json').then(function(r){return r.json();}).then(function(d){
  DATA = d;
  P = DATA.map(function(d){return{idx:d[0],lat:d[1],lng:d[2],alt:d[3],time:d[4]};});
  initEditor();
}).catch(function(e){
  console.warn('No track data loaded, showing drop zone:', e);
  P = [];
  initEditor();
});

// Compute total distance (Haversine)
function computeDistance(pts) {
  if (pts.length < 2) return 0;
  function rad(d) { return d * Math.PI / 180; }
  var total = 0;
  for (var i = 1; i < pts.length; i++) {
    var p1 = pts[i - 1], p2 = pts[i];
    var dlat = rad(p2[1] - p1[1]);
    var dlon = rad(p2[2] - p1[2]);
    var a = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
            Math.cos(rad(p1[1])) * Math.cos(rad(p2[1])) *
            Math.sin(dlon / 2) * Math.sin(dlon / 2);
    total += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

function formatDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  var y = d.getFullYear();
  var m = ('0' + (d.getMonth() + 1)).slice(-2);
  var day = ('0' + d.getDate()).slice(-2);
  return y + '-' + m + '-' + day;
}

function renderFileInfo() {
  var el = document.getElementById('fileInfo');
  if (!el) return;
  if (P.length === 0) {
    el.innerHTML = '<div class="placeholder"><span class="icon">📂</span>暂无轨迹<br>拖放 KMZ 文件到地图</div>';
    return;
  }
  var name = fileMeta.name || DATA._name || '轨迹';
  if (name.endsWith('.kmz')) name = name.slice(0, -4);
  var date = formatDate(P[0].time);
  var dist = computeDistance(DATA);
  var distStr = dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist.toFixed(0) + ' m';
  el.innerHTML = '<div class="name">' + escHtml(name) + '</div>' +
    '<div class="meta-row"><span class="label">记录时间</span> ' + date + '</div>' +
    '<div class="meta-row"><span class="label">轨迹长度</span> ' + distStr + '</div>' +
    '<div class="meta-row"><span class="label">轨迹点数</span> ' + P.length + '</div>';
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Drop zone helpers
function showDropZone() {
  var dz = document.getElementById('dropZone');
  if (!dz) return;
  dz.classList.add('active');
}

function hideDropZone() {
  var dz = document.getElementById('dropZone');
  if (!dz) return;
  dz.classList.remove('active');
}

function setDropZonePersistent(show) {
  var dz = document.getElementById('dropZone');
  if (!dz) return;
  if (show) {
    dz.classList.add('permanent');
  } else {
    dz.classList.remove('permanent');
    dz.classList.remove('active');
  }
}

// Document-level drag-and-drop events (handles file drop anywhere on window)
document.addEventListener('dragenter', function(e) {
  e.preventDefault();
  dragCounter++;
  showDropZone();
});

document.addEventListener('dragover', function(e) {
  e.preventDefault();
});

document.addEventListener('dragleave', function(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    if (P.length === 0) {
      // Keep permanent hint visible, but remove active highlight
      setDropZonePersistent(true);
    } else {
      hideDropZone();
    }
  }
});

document.addEventListener('drop', function(e) {
  e.preventDefault();
  dragCounter = 0;
  if (P.length > 0) {
    hideDropZone();
  } else {
    setDropZonePersistent(true);
  }

  var files = e.dataTransfer.files;
  if (!files || files.length === 0) return;

  var file = files[0];
  if (!file.name.toLowerCase().endsWith('.kmz')) {
    alert('请拖入 .kmz 格式的轨迹文件');
    return;
  }

  // Show processing overlay
  var overlay = document.getElementById('overlay');
  document.getElementById('overlayText').textContent = '正在处理 ' + file.name + ' ...';
  overlay.style.display = 'flex';

  var fd = new FormData();
  fd.append('kmz', file);

  fetch('/upload', {method: 'POST', body: fd})
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.success) {
        document.getElementById('overlayText').textContent = '加载完成，正在刷新...';
        setTimeout(function() { location.reload(); }, 1500);
      } else {
        overlay.style.display = 'none';
        alert('处理失败: ' + d.error);
      }
    })
    .catch(function(err) {
      overlay.style.display = 'none';
      alert('上传失败: ' + err.message);
    });
});

// Initialize map (called always, even when no data)
function initEditor() {

// Initialize map
mm = L.map('map', {zoomControl: true, maxZoom: 20, attributionControl: false});

osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: 'OSM', maxZoom: 20});
sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {attribution: 'Esri', maxZoom: 20, maxNativeZoom: 17});
labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {attribution: 'Esri', maxZoom: 20, maxNativeZoom: 17});
sat.addTo(mm);
labels.addTo(mm);
activeLabels = labels;

// Map layer switch buttons
document.getElementById('mapSwitch').addEventListener('click', function(e) {
  var btn = e.target.closest('button');
  if (!btn || !btn.dataset.map) return;
  var val = btn.dataset.map;
  // Update active state
  this.querySelectorAll('button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  // Switch layer
  if (val == 'satellite') {
    mm.removeLayer(osm);
    sat.addTo(mm);
    labels.addTo(mm);
    activeLabels = labels;
  } else {
    mm.removeLayer(sat);
    mm.removeLayer(labels);
    activeLabels = null;
    osm.addTo(mm);
  }
});

if (P.length > 0) {
  pts = P.map(function(p) { return [p.lat, p.lng]; });
  pl = L.polyline(pts, {color: '#22c55e', weight: 4, opacity: 0.8}).addTo(mm);

  var step = Math.max(1, Math.floor(P.length / 30));
  for (var i = 0; i < P.length; i += step) {
    (function(j) {
      L.circleMarker([P[j].lat, P[j].lng], {
        radius: 4, color: '#458fff', fill: true,
        fillColor: '#458fff', fillOpacity: 0.8, weight: 1
      }).addTo(mm).bindTooltip('#' + j).on('click', function() { showInfo(j); });
    })(i);
  }
} else {
  pts = [];
}

function nearestLL(latlng) {
  if (P.length === 0) return null;
  var d = Infinity, n = null;
  for (var i = 0; i < P.length; i++) {
    var dist = mm.distance(latlng, [P[i].lat, P[i].lng]);
    if (dist < d) { d = dist; n = i; }
  }
  return n;
}

function showInfo(i) {
  var latlng = L.latLng(P[i].lat, P[i].lng);
  var popupContent = '<div style="font-size:12px;line-height:1.6">' +
    '<b>#' + i + '</b><br>' +
    '时间: ' + P[i].time + '<br>' +
    '纬度: ' + P[i].lat.toFixed(6) + '<br>' +
    '经度: ' + P[i].lng.toFixed(6) + '<br>' +
    '海拔: ' + P[i].alt + 'm' +
    '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">' +
    '<button onclick="document.querySelector(\'.leaflet-popup-close-button\').click(); clearSel()" style="background:var(--border);border:none;color:var(--ink);border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer">取消</button>' +
    '</div></div>';
  L.popup({closeButton: true, maxWidth: 300})
    .setLatLng(latlng)
    .setContent(popupContent)
    .openOn(mm);
}

if (P.length > 0) {
  pl.on('click', function(e) {
    if (e.originalEvent) {
      var t = e.originalEvent.target;
      if (t && (document.getElementById('panel').contains(t) || document.getElementById('mapTools').contains(t))) return;
    }
    if (ss !== null && se !== null) {
      updateSelInfo(ss, se);
      return;
    }
    var i = nearestLL(e.latlng);
    if (i != null) showInfo(i);
  });
}

// ss, se, sm, rv, removedLines declared at global scope

// Restore deletion marks from localStorage on page load
(function() {
  var saved = localStorage.getItem('trackEditor_removals');
  if (saved) {
    try {
      rv = JSON.parse(saved);
    } catch(e) {}
  }
})();




clearSel = function() {
  ss = null; se = null;
  sm.forEach(function(x) { mm.removeLayer(x); });
  sm = [];
  updateSelInfo(null, null);
  }



function updateSel() {
  sm.forEach(function(x) { mm.removeLayer(x); });
  sm = [];
  if (ss != null && se != null) {
    var s = Math.min(ss, se), e = Math.max(ss, se);
    var sl = L.polyline(pts.slice(s, e + 1), {color: '#ef4444', weight: 6, opacity: 0.9}).addTo(mm);
    sl.on('click', function() {
      if (ss !== null && se !== null) updateSelInfo(ss, se);
    });
    sm.push(sl);
    var sm1 = L.circleMarker([P[s].lat, P[s].lng], {radius: 8, color: '#ef4444', fill: true, fillColor: '#ef4444', fillOpacity: 1, weight: 2}).addTo(mm);
    sm1.bindTooltip('#' + s);
    sm.push(sm1);
    var sm2 = L.circleMarker([P[e].lat, P[e].lng], {radius: 8, color: '#ef4444', fill: true, fillColor: '#ef4444', fillOpacity: 1, weight: 2}).addTo(mm);
    sm2.bindTooltip('#' + e);
    sm.push(sm2);
    mm.fitBounds(sl.getBounds(), {padding: [30, 30]});
  } else if (ss != null) {
    var sm1 = L.circleMarker([P[ss].lat, P[ss].lng], {radius: 8, color: '#f59e0b', fill: true, fillColor: '#f59e0b', fillOpacity: 1, weight: 2}).addTo(mm);
    sm1.bindTooltip('#' + ss);
    sm.push(sm1);
  }
}

if (P.length > 0) {
  mm.on('click', function(e) {
    // Ignore clicks on panel or map-switch (event bubbling)
    if (e.originalEvent) {
      var t = e.originalEvent.target;
      if (t && (document.getElementById('panel').contains(t) || document.getElementById('mapTools').contains(t))) return;
    }
    var i = nearestLL(e.latlng);
    if (i == null) return;
    if (ss == null) {
      ss = i;
      showInfo(i);
    } else if (se == null && ss != null) {
      if (i == ss) {
        ss = null;
        clearSel();
        updateSelInfo(null, null);
      } else {
        se = i;
        var s = Math.min(ss, se), e = Math.max(ss, se);
        updateSelInfo(ss, se);
      }
    }
    updateSel();
  });
}



document.getElementById('btnDownload').onclick = function() {
  var overlay = document.getElementById('overlay');
  document.getElementById('overlayText').textContent = '正在处理 ' + rv.length + ' 个删除范围...';
  overlay.style.display = 'flex';
  fetch('/api/apply-edits', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({removals: rv, totalPts: P.length})
  }).then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('overlayText').textContent = '处理完成，正在导出...';
    setTimeout(function() {
      overlay.style.display = 'none';
      window.location.href = data.downloadUrl || '/download/edited_track.kmz';
    }, 2000);
  }).catch(function(e) {
    overlay.style.display = 'none';
    var txt = JSON.stringify(rv);
    alert('请将以下内容复制发送给小满：\n\n' + txt);
    prompt('发送给小满', txt);
  });
};

if (P.length > 0) {
  mm.fitBounds(pl.getBounds(), {padding: [30, 30]});
  setDropZonePersistent(false);
} else {
  mm.setView([35, 110], 4);
  setDropZonePersistent(true);
}

// Update stats and file info
updateStats();
renderFileInfo();

}  // end initEditor


function updateSelInfo(s, e) {
  if (s === null || e === null) {
    return;
  }
  var st = Math.min(s, e), en = Math.max(s, e);
  var cnt = en - st + 1;
  var p1 = P[st], p2 = P[en];
  var mlat = (p1.lat + p2.lat) / 2;
  var mlng = (p1.lng + p2.lng) / 2;
  var html = '<div style="font-size:12px;line-height:1.6">' +
    '<b>#' + st + ' \u2192 #' + en + '</b><br>' + cnt + ' \u4e2a\u70b9<br>' +
    '\u8d77\u70b9: ' + p1.lat.toFixed(5) + ', ' + p1.lng.toFixed(5) + '<br>' +
    '\u7ec8\u70b9: ' + p2.lat.toFixed(5) + ', ' + p2.lng.toFixed(5) + '<br>' +
    '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;display:flex;gap:6px">' +
    '<button onclick="document.querySelector(\'.leaflet-popup-close-button\').click(); confirmDelete()" style="background:var(--coral);color:#fff;border:none;border-radius:999px;padding:4px 14px;font-size:11px;cursor:pointer;font-weight:500">删除</button>' +
    '<button onclick="document.querySelector(\'.leaflet-popup-close-button\').click(); clearSel()" style="background:var(--surface-soft);border:1px solid var(--border);color:var(--ink);border-radius:999px;padding:4px 14px;font-size:11px;cursor:pointer;font-weight:500">重置</button>' +
    '</div></div>';
  L.popup({closeButton: true, maxWidth: 300}).setLatLng([mlat, mlng]).setContent(html).openOn(mm);
}


function refreshDelList() {
  var el = document.getElementById('removalsList');
  document.getElementById('delListCount').textContent = rv.length + ' \u6bb5';
  if (rv.length === 0) {
    el.innerHTML = '<div class="empty">\u6682\u65e0\u5220\u9664\u8def\u5f84</div>';
    return;
  }
  var h = '';
  for (var i = rv.length - 1; i >= 0; i--) {
    var r = rv[i];
    var cnt = r.end - r.start + 1;
    h += '<div class="item" data-idx="' + i + '">' +
      '<span class="label">#' + r.start + '\u2192#' + r.end + ' <span >(' + cnt + ')</span></span>' +
      '<button class="remove" onclick="undoDelete(' + i + ')">\u2715</button>' +
      '</div>';
  }
  el.innerHTML = h;
  
  el.querySelectorAll('[data-idx]').forEach(function(div) {
    div.addEventListener('click', function(e) {
      if (e.target.tagName === 'BUTTON') return;
      var idx = parseInt(this.dataset.idx);
      var r = rv[idx];
      highlightRange(r.start, r.end);
    });
  });
}

function undoDelete(idx) {
  var r = rv[idx];
  rv.splice(idx, 1);
  localStorage.setItem('trackEditor_removals', JSON.stringify(rv));
  for (var i = 0; i < removedLines.length; i++) {
    if (removedLines[i]._delInfo && removedLines[i]._delInfo.start === r.start && removedLines[i]._delInfo.end === r.end) {
      mm.removeLayer(removedLines[i]);
      removedLines.splice(i, 1);
      break;
    }
  }
  updateStats();
  refreshDelList();
}

function highlightRange(s, e) {
  if (window._hlLine) { mm.removeLayer(window._hlLine); }
  window._hlLine = L.polyline(pts.slice(s, e + 1), {color: '#fbbf24', weight: 8, opacity: 0.9}).addTo(mm);
  mm.fitBounds(window._hlLine.getBounds(), {padding: [30, 30]});
  setTimeout(function() {
    if (window._hlLine) { mm.removeLayer(window._hlLine); window._hlLine = null; }
  }, 3000);
}

function confirmDelete() {
  if (ss === null || se === null) { return; }
  var s = Math.min(ss, se), e = Math.max(ss, se);
  rv.push({start:s, end:e});
  localStorage.setItem('trackEditor_removals', JSON.stringify(rv));
  updateStats();
  var rl = L.polyline(pts.slice(s, e + 1), {color: '#ef4444', weight: 6, opacity: 0.7}).addTo(mm);
  removedLines.push(rl);
  rl._delInfo = {start: s, end: e};
  updateSelInfo(null, null);
  clearSel();
  refreshDelList();
}




// Sidebar resize
(function(){
  var handle = document.getElementById('resizeHandle');
  var panel = document.getElementById('panel');
  if (!handle || !panel) { /* panel not found */ return; }
  var isDragging = false;
  
  handle.addEventListener('mousedown', function(e) {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  
  document.addEventListener('mousemove', function(e) {
    if (!isDragging) return;
    var width = Math.max(200, Math.min(500, e.clientX));
    panel.style.width = width + 'px';
  });
  
  document.addEventListener('mouseup', function() {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Trigger map resize
      if (typeof mm !== 'undefined') {
        setTimeout(function() { mm.invalidateSize(); }, 50);
      }
    }
  });
})();



