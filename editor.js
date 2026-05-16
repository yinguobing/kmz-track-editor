// Update stats shown in panel (points count, deletion count)
function updateStats() {
  var el, del = removals.reduce(function(a, r) { return a + r.end - r.start + 1; }, 0);
  el = document.getElementById('delPts'); if (el) el.textContent = del;
}

// ===== State =====
var map, osmLayer, satLayer, labels, latlngs, trackLine, pointMarkers;
var removals = [], selStart = null, selEnd = null, selMarkers = [], removedLines = [];
var rawData = [];
var dragCounter = 0;
var fileMeta = {};
var points = [];
var waypoints = [];
var wpGroup;
var wpVisible = true;

// ===== Helpers =====

// Check if a click event originated from panel or mapTools (should be ignored)
function isClickOnUI(origEvent) {
  if (!origEvent) return false;
  var t = origEvent.target;
  if (!t) return false;
  return document.getElementById('panel').contains(t) || document.getElementById('mapTools').contains(t);
}

// Show/hide overlay with message
// Prevent mouse wheel from zooming map when scrolling panel/list
document.getElementById('panel').addEventListener('wheel', function(e) {
  e.stopPropagation();
}, {passive: true});

// ===== Data Loading =====
fetch('/upload_meta.json').then(function(r){return r.json();}).then(function(d){
  fileMeta = d;
  renderFileInfo();
}).catch(function(){});

fetch('/track_data.json').then(function(r){return r.json();}).then(function(d){
  rawData = d;
  points = rawData.map(function(d){return{idx:d[0],lat:d[1],lng:d[2],alt:d[3],time:d[4]};});
  initEditor();
}).catch(function(e){
  console.warn('No track data loaded, showing drop zone:', e);
  points = [];
  initEditor();
});

// Load waypoints
fetch('/waypoints.json').then(function(r){return r.json();}).then(function(d){
  waypoints = d;
  renderWaypoints();
  renderFileInfo();
}).catch(function(){});

// Compute total distance (Haversine)
function computeDistance(data) {
  if (data.length < 2) return 0;
  function rad(deg) { return deg * Math.PI / 180; }
  var total = 0;
  for (var i = 1; i < data.length; i++) {
    var p1 = data[i - 1], p2 = data[i];
    var dlat = rad(p2[1] - p1[1]);
    var dlon = rad(p2[2] - p1[2]);
    var a = Math.sin(dlat / 2) * Math.sin(dlat / 2) +
            Math.cos(rad(p1[1])) * Math.cos(rad(p2[1])) *
            Math.sin(dlon / 2) * Math.sin(dlon / 2);
    total += 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  return total;
}

// Fit map bounds accounting for sidebar panel overlay
function fitBoundsWithPanel(bounds, extra) {
  var pw = (document.getElementById('panel') || {}).offsetWidth || 300;
  var pad = extra || 30;
  map.fitBounds(bounds, {paddingTopLeft: [pad, pad], paddingBottomRight: [pad + pw, pad]});
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
  if (points.length === 0) {
    el.innerHTML = '<div class="placeholder"><span class="icon">📂</span>暂无轨迹<br>拖放 KMZ 文件到地图</div>';
    return;
  }
  var name = fileMeta.name || rawData._name || '轨迹';
  if (name.endsWith('.kmz')) name = name.slice(0, -4);
  var date = formatDate(points[0].time);
  var dist = computeDistance(rawData);
  var distStr = dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist.toFixed(0) + ' m';
  var wpCount = waypoints.length;
  el.innerHTML = '<div class="name">' + escHtml(name) + '</div>' +
    '<div class="sub">' + date + '</div>' +
    '<div class="file-metrics">' +
      '<div class="metric"><div class="metric-label">轨迹长度</div><div class="metric-value">' + distStr + '</div></div>' +
      '<div class="metric"><div class="metric-label">轨迹点数</div><div class="metric-value">' + points.length.toLocaleString() + '</div></div>' +
      '<div class="metric"><div class="metric-label">标注点</div><div class="metric-value" style="font-size:16px;display:flex;align-items:center;justify-content:center;gap:4px">' + wpCount + '<span class="eye-btn" onclick="toggleWaypoints()">' + (wpVisible ? '👁' : '👁‍🗨') + '</span></div></div>' +
    '</div>';
}

function escHtml(s) {
  var d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===== Waypoints =====
function toggleWaypoints() {
  if (!wpGroup) return;
  wpVisible = !wpVisible;
  if (wpVisible) {
    map.addLayer(wpGroup);
  } else {
    map.removeLayer(wpGroup);
  }
  renderFileInfo();
}

function renderWaypoints() {
  if (waypoints.length === 0 || !map) return;
  
  for (var i = 0; i < waypoints.length; i++) {
    var wp = waypoints[i];
    // Create diamond icon
    var icon = L.divIcon({
      className: 'wp-icon',
      html: '<div class="wp-diamond"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    
    var m = L.marker([wp.lat, wp.lng], {icon: icon});
    m.bindTooltip(escHtml(wp.name), {sticky: true});
    m.on('click', function(w) {
      return function() {
        var html = '<div class="wp-popup">' +
          '<h3>' + escHtml(w.name) + '</h3>';
        if (w.desc) {
          // Clean desc HTML: constrain images, render embeds as video
          var descHtml = w.desc
            .replace(/<img /g, '<img style="max-width:100%;max-height:260px;object-fit:contain" loading="lazy" ')
            .replace(/<embed[^>]+src="([^"]+)"[^>]*>/gi, '<video controls style="max-width:100%;max-height:260px;border-radius:6px;margin:4px 0" preload="metadata"><source src="/$1"></video>');
          html += '<div class="desc">' + descHtml + '</div>';
        }
        html += '</div>';
        this.unbindTooltip();
        this.bindPopup(html, {maxWidth: 380, minWidth: 280}).openPopup();
      };
    }(wp));
    
    m.addTo(wpGroup);
  }
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
    if (points.length === 0) {
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
  if (points.length > 0) {
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
        localStorage.removeItem('trackEditor_removals');
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
map = L.map('map', {zoomControl: false, maxZoom: 20, attributionControl: false});
L.control.zoom({position: 'topleft', zoomInTitle: '放大地图', zoomOutTitle: '缩小地图'}).addTo(map);

osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: 'OSM', maxZoom: 20});
satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {attribution: 'Esri', maxZoom: 20, maxNativeZoom: 17});
labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {attribution: 'Esri', maxZoom: 20, maxNativeZoom: 17});
satLayer.addTo(map);
labels.addTo(map);


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
    map.removeLayer(osmLayer);
    satLayer.addTo(map);
    labels.addTo(map);
    if (trackLine) trackLine.setStyle({color: '#00f5d4'});
    if (pointMarkers) pointMarkers.eachLayer(function(l) { l.setStyle({color: '#00f5d4', fillColor: '#00f5d4'}); });
  } else {
    map.removeLayer(satLayer);
    map.removeLayer(labels);
    osmLayer.addTo(map);
    if (trackLine) trackLine.setStyle({color: '#2563eb'});
    if (pointMarkers) pointMarkers.eachLayer(function(l) { l.setStyle({color: '#2563eb', fillColor: '#2563eb'}); });
  }
});

if (points.length > 0) {
  latlngs = points.map(function(p) { return [p.lat, p.lng]; });
  trackLine = L.polyline(latlngs, {color: '#00f5d4', weight: 5, opacity: 0.8}).addTo(map);

  // Layer group for waypoints
  wpGroup = L.layerGroup().addTo(map);

  // Show every point as tiny dot with hover tooltip
  pointMarkers = L.layerGroup().addTo(map);
  for (var i = 0; i < points.length; i++) {
    L.circleMarker([points[i].lat, points[i].lng], {
      radius: 2, color: '#00f5d4', fill: true,
      fillColor: '#00f5d4', fillOpacity: 0.2, weight: 1
    }).addTo(pointMarkers).bindTooltip('#' + i, {sticky: true});
  }
} else {
  latlngs = [];
}

function nearestLL(latlng) {
  if (points.length === 0) return null;
  var d = Infinity, n = null, threshold = 60; // meters
  for (var i = 0; i < points.length; i++) {
    var dist = map.distance(latlng, [points[i].lat, points[i].lng]);
    if (dist < d) { d = dist; n = i; }
  }
  return d <= threshold ? n : null;
}

function showInfo(i) {
  var latlng = L.latLng(points[i].lat, points[i].lng);
  var popupContent = '<div style="font-size:12px;line-height:1.6">' +
    '<b>#' + i + '</b><br>' +
    '时间: ' + points[i].time + '<br>' +
    '纬度: ' + points[i].lat.toFixed(6) + '<br>' +
    '经度: ' + points[i].lng.toFixed(6) + '<br>' +
    '海拔: ' + points[i].alt + 'm' +
    '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px">' +
    '<button onclick="document.querySelector(\'.leaflet-popup-close-button\').click(); clearSel()" style="background:var(--border);border:none;color:var(--ink);border-radius:999px;padding:3px 10px;font-size:11px;cursor:pointer">取消</button>' +
    '</div></div>';
  L.popup({closeButton: true, maxWidth: 300})
    .setLatLng(latlng)
    .setContent(popupContent)
    .openOn(map);
}

if (points.length > 0) {
  trackLine.on('click', function(e) {
    if (isClickOnUI(e.originalEvent)) return;
    if (selStart !== null && selEnd !== null) {
      updateSelInfo(selStart, selEnd);
      return;
    }
    var i = nearestLL(e.latlng);
    if (i != null) showInfo(i);
  });
}

// selStart, selEnd, selMarkers, removals, removedLines declared at global scope

// Restore deletion marks from localStorage on page load
(function() {
  var saved = localStorage.getItem('trackEditor_removals');
  if (saved) {
    try {
      removals = JSON.parse(saved);
    } catch(e) {}
  }
})();




clearSel = function() {
  selStart = null; selEnd = null;
  selMarkers.forEach(function(x) { map.removeLayer(x); });
  selMarkers = [];
  updateSelInfo(null, null);
  }



function updateSel() {
  selMarkers.forEach(function(x) { map.removeLayer(x); });
  selMarkers = [];
  if (selStart != null && selEnd != null) {
    var s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
    var sl = L.polyline(latlngs.slice(s, e + 1), {color: '#facc15', weight: 6, opacity: 0.9}).addTo(map);
    sl.on('click', function() {
      if (selStart !== null && selEnd !== null) updateSelInfo(selStart, selEnd);
    });
    selMarkers.push(sl);
    var sm1 = L.circleMarker([points[s].lat, points[s].lng], {radius: 8, color: '#facc15', fill: true, fillColor: '#facc15', fillOpacity: 1, weight: 2}).addTo(map);
    sm1.bindTooltip('#' + s);
    selMarkers.push(sm1);
    var sm2 = L.circleMarker([points[e].lat, points[e].lng], {radius: 8, color: '#facc15', fill: true, fillColor: '#facc15', fillOpacity: 1, weight: 2}).addTo(map);
    sm2.bindTooltip('#' + e);
    selMarkers.push(sm2);
    fitBoundsWithPanel(sl.getBounds());
  } else if (selStart != null) {
    var sm1 = L.circleMarker([points[selStart].lat, points[selStart].lng], {radius: 8, color: '#f59e0b', fill: true, fillColor: '#f59e0b', fillOpacity: 1, weight: 2}).addTo(map);
    sm1.bindTooltip('#' + selStart);
    selMarkers.push(sm1);
  }
}

if (points.length > 0) {
  map.on('click', function(e) {
    // Ignore clicks on panel or map-switch (event bubbling)
    if (isClickOnUI(e.originalEvent)) return;
    var i = nearestLL(e.latlng);
    if (i == null) return;
    if (selStart == null) {
      selStart = i;
      showInfo(i);
    } else if (selEnd == null && selStart != null) {
      if (i == selStart) {
        selStart = null;
        clearSel();
        updateSelInfo(null, null);
      } else {
        selEnd = i;
        var s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
        updateSelInfo(selStart, selEnd);
      }
    }
    updateSel();
  });

  // Hover feedback: enlarge nearest point
  var hoverDot = L.circleMarker([0, 0], {
    radius: 7, color: '#fff', fill: true,
    fillColor: '#00f5d4', fillOpacity: 0.9, weight: 2
  }).addTo(map);
  hoverDot.bindTooltip('', {sticky: true});
  var hoverIdx = -1, hoverTick = 0;
  map.on('mousemove', function(e) {
    hoverTick++;
    if (hoverTick % 2 !== 0) return;
    if (isClickOnUI(e.originalEvent)) {
      if (hoverIdx !== -1) { hoverDot.setLatLng([0, 0]); hoverIdx = -1; map.getContainer().style.cursor = ''; }
      return;
    }
    var idx = nearestLL(e.latlng);
    if (idx !== null && idx !== hoverIdx) {
      hoverIdx = idx;
      hoverDot.setLatLng([points[idx].lat, points[idx].lng]);
      hoverDot.setTooltipContent('#' + idx);
      map.getContainer().style.cursor = 'pointer';
    } else if (idx === null && hoverIdx !== -1) {
      hoverDot.setLatLng([0, 0]);
      hoverIdx = -1;
      map.getContainer().style.cursor = '';
    }
  });
}



document.getElementById('btnDownload').onclick = function() {
  var overlay = document.getElementById('overlay');
  document.getElementById('overlayText').textContent = '正在处理 ' + removals.length + ' 个删除范围...';
  overlay.style.display = 'flex';
  fetch('/api/apply-edits', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({removals: removals, totalPts: points.length})
  }).then(function(r) { return r.json(); }).then(function(data) {
    document.getElementById('overlayText').textContent = '处理完成，正在导出...';
    setTimeout(function() {
      overlay.style.display = 'none';
      window.location.href = data.downloadUrl || '/download/edited_track.kmz';
    }, 2000);
  }).catch(function(e) {
    overlay.style.display = 'none';
    var txt = JSON.stringify(removals);
    alert('请将以下内容复制发送给小满：\n\n' + txt);
    prompt('发送给小满', txt);
  });
};

document.getElementById('btnClear').onclick = clearAllDeletions;

// Add reset view control to map (top-left with zoom controls)
L.Control.ResetView = L.Control.extend({
  onAdd: function() {
    var btn = L.DomUtil.create('button', 'leaflet-control-reset');
    btn.innerHTML = '⟲';
    btn.title = '重置地图视图';
    btn.style.cssText = 'width:30px;height:30px;background:var(--surface);color:var(--ink);border:2px solid var(--border);cursor:pointer;font-size:18px;font-weight:bold;line-height:30px;text-align:center;padding:0;margin-top:4px;border-radius:2px';
    L.DomEvent.on(btn, 'click', function(e) {
      L.DomEvent.stopPropagation(e);
      if (trackLine) fitBoundsWithPanel(trackLine.getBounds());
    });
    return btn;
  }
});
new L.Control.ResetView({position: 'topleft'}).addTo(map);

if (points.length > 0) {
  fitBoundsWithPanel(trackLine.getBounds());
  setDropZonePersistent(false);
} else {
  map.setView([35, 110], 4);
  setDropZonePersistent(true);
}

// Update stats, file info, deletion list, and waypoints
updateStats();
renderFileInfo();
refreshDelList();
renderWaypoints();

}  // end initEditor


function updateSelInfo(s, e) {
  if (s === null || e === null) {
    return;
  }
  var st = Math.min(s, e), en = Math.max(s, e);
  var cnt = en - st + 1;
  var p1 = points[st], p2 = points[en];
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
  L.popup({closeButton: true, maxWidth: 300}).setLatLng([mlat, mlng]).setContent(html).openOn(map);
}


function refreshDelList() {
  var el = document.getElementById('removalsList');
  var footer = document.getElementById('delFooter');
  var countEl = document.getElementById('delCount');
  
  if (removals.length === 0) {
    el.innerHTML = '<div class="empty">尚未删除任何路径</div>';
    if (footer) footer.style.display = 'none';
    return;
  }
  
  if (footer) footer.style.display = 'flex';
  if (countEl) countEl.textContent = '已删除 ' + removals.length + ' 段';
  
  var h = '';
  for (var i = removals.length - 1; i >= 0; i--) {
    var r = removals[i];
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
      var r = removals[idx];
      highlightRange(r.start, r.end);
    });
  });
}

function undoDelete(idx) {
  var r = removals[idx];
  removals.splice(idx, 1);
  localStorage.setItem('trackEditor_removals', JSON.stringify(removals));
  for (var i = 0; i < removedLines.length; i++) {
    if (removedLines[i]._delInfo && removedLines[i]._delInfo.start === r.start && removedLines[i]._delInfo.end === r.end) {
      map.removeLayer(removedLines[i]);
      removedLines.splice(i, 1);
      break;
    }
  }
  updateStats();
  refreshDelList();
}

function clearAllDeletions() {
  if (removals.length === 0) return;
  for (var i = 0; i < removedLines.length; i++) {
    map.removeLayer(removedLines[i]);
  }
  removedLines = [];
  removals = [];
  localStorage.removeItem('trackEditor_removals');
  updateStats();
  refreshDelList();
}

function highlightRange(s, e) {
  if (window._hlLine) { map.removeLayer(window._hlLine); }
  window._hlLine = L.polyline(latlngs.slice(s, e + 1), {color: '#fbbf24', weight: 8, opacity: 0.9}).addTo(map);
  fitBoundsWithPanel(window._hlLine.getBounds());
  setTimeout(function() {
    if (window._hlLine) { map.removeLayer(window._hlLine); window._hlLine = null; }
  }, 3000);
}

function confirmDelete() {
  if (selStart === null || selEnd === null) { return; }
  var s = Math.min(selStart, selEnd), e = Math.max(selStart, selEnd);
  removals.push({start:s, end:e});
  localStorage.setItem('trackEditor_removals', JSON.stringify(removals));
  updateStats();
  var rl = L.polyline(latlngs.slice(s, e + 1), {color: '#6b7280', weight: 5, opacity: 0.5}).addTo(map);
  removedLines.push(rl);
  rl._delInfo = {start: s, end: e};
  updateSelInfo(null, null);
  clearSel();
  refreshDelList();
}








