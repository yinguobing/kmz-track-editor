function updateStatsWithLocalStorage() {
  var saved = localStorage.getItem("trackEditor_removals");
  if (saved) {
    try {
      rv = JSON.parse(saved);
      if (rv.length > 0) {
        var d = rv.reduce(function(a,r){return a+r.end-r.start+1}, 0);
        document.getElementById("delPts").textContent = d;
        document.getElementById("finalPts").textContent = P.length - d;
        document.getElementById("selectionInfo").innerHTML = "<span style=\"color:var(--amber)\">已从缓存恢复 " + rv.length + " 个删除标记</span>";
      }
    } catch(e) {}
  }
}

var trackName = "两步路轨迹编辑器";
// Global vars for map state - assigned in initEditor
var mm, osm, sat, labels, activeLabels, pts, pl;
var rv = [], ss = null, se = null, sm = [], removedLines = [];
var clearSel;
var DATA = [];  // loaded from track_data.json


var P = [];

// Load track data from JSON
fetch('/track_data.json').then(function(r){return r.json();}).then(function(d){
  DATA = d;
  P = DATA.map(function(d){return{idx:d[0],lat:d[1],lng:d[2],alt:d[3],time:d[4]};});
  updateStatsWithLocalStorage();
  initEditor();
}).catch(function(e){
  console.warn('No track data, upload a KMZ file:', e);
  P=[];
  document.getElementById('selectionInfo').innerHTML = '<span style="color:var(--body)">无轨迹数据，请上传 KMZ 文件</span>';
});

// Initialize map (called after data loads)
function initEditor() {

// Initialize map
mm = L.map('map', {zoomControl: true, maxZoom: 20, attributionControl: false}).setView([38.972362000000004, 112.4864345], 12);

osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: 'OSM', maxZoom: 20});
sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {attribution: 'Esri', maxZoom: 20, maxNativeZoom: 17});
labels = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {attribution: 'Esri', maxZoom: 20, maxNativeZoom: 17});
sat.addTo(mm);
labels.addTo(mm);
activeLabels = labels;

document.getElementById('mapSelect').onchange = function() {
  if (this.value == 'satellite') {
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
};

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

function nearestLL(latlng) {
  var d = Infinity, n = null;
  for (var i = 0; i < P.length; i++) {
    var dist = mm.distance(latlng, [P[i].lat, P[i].lng]);
    if (dist < d) { d = dist; n = i; }
  }
  return n;
}

function showInfo(i) {
  document.getElementById('selectionInfo').innerHTML =
    '<div class="section-title" style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--ink);font-weight:600">#' + i + '</div>' +
    '<div>时间: ' + P[i].time + '</div>' +
    '<div>纬度: ' + P[i].lat.toFixed(6) + '</div>' +
    '<div>经度: ' + P[i].lng.toFixed(6) + '</div>' +
    '<div>海拔: ' + P[i].alt + 'm</div>';
}

pl.on('click', function(e) {
  var i = nearestLL(e.latlng);
  if (i != null) showInfo(i);
});

// ss, se, sm, rv, removedLines declared at global scope

// Restore deletion marks from localStorage on page load
(function() {
  var saved = localStorage.getItem('trackEditor_removals');
  if (saved) {
    try {
      rv = JSON.parse(saved);
      if (rv.length > 0) {
        document.getElementById('selectionInfo').innerHTML = '<span style="color:var(--amber)">↻ 已恢复 ' + rv.length + ' 个删除标记</span>';
        var del = rv.reduce(function(a, r) { return a + r.end - r.start + 1; }, 0);
        document.getElementById('delPts').textContent = del;
        document.getElementById('finalPts').textContent = P.length - del;
      }
    } catch(e) {}
  }
})();




clearSel = function() {
  ss = null; se = null;
  sm.forEach(function(x) { mm.removeLayer(x); });
  sm = [];
  updateSelInfo(null, null);
  document.getElementById('btnClear').disabled = true;
}

document.getElementById('btnClear').onclick = clearSel;


function updateSel() {
  sm.forEach(function(x) { mm.removeLayer(x); });
  sm = [];
  if (ss != null && se != null) {
    var s = Math.min(ss, se), e = Math.max(ss, se);
    var sl = L.polyline(pts.slice(s, e + 1), {color: '#ef4444', weight: 6, opacity: 0.9}).addTo(mm);
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

mm.on('click', function(e) {
  // Always in selection mode
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
      document.getElementById('selectionInfo').innerHTML = '<div style="color:var(--ink);font-weight:600;font-size:12px">已选中</div>选中 <b>#' + s + '</b> &rarr; <b>#' + e + '</b> (' + (e - s + 1) + ' pts)';
      document.getElementById('btnClear').disabled = false;
      updateSelInfo(ss, se);
    }
  }
  updateSel();
});



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

mm.fitBounds(pl.getBounds(), {padding: [30, 30]});

}  // end initEditor


function updateSelInfo(s, e) {
  var info = document.getElementById('selectionInfo');
  var btn = document.getElementById('btnConfirmDel');
  if (s === null || e === null) {
    info.innerHTML = '<div >点选轨迹上的起点和终点</div>';
    btn.disabled = true;
    return;
  }
  var start = Math.min(s, e), end = Math.max(s, e);
  var pts_count = end - start + 1;
  var p1 = P[start], p2 = P[end];
  info.innerHTML = '<div class="section-title" style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--ink);font-weight:600">#' + start + ' \u2192 #' + end + '</div>' +
    '<div>' + pts_count + ' \u4e2a\u70b9</div>' +
    '<div class="detail-text">\u8d77\u70b9: ' + p1.lat.toFixed(5) + ', ' + p1.lng.toFixed(5) + '</div>' +
    '<div class="detail-text">\u7ec8\u70b9: ' + p2.lat.toFixed(5) + ', ' + p2.lng.toFixed(5) + '</div>';
  btn.disabled = false;
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
  var del = rv.reduce(function(a, r2) { return a + r2.end - r2.start + 1; }, 0);
  document.getElementById('delPts').textContent = del;
  document.getElementById('finalPts').textContent = P.length - del;
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

// btnConfirmDel handler
document.getElementById('btnConfirmDel').onclick = function() {
  if (ss === null || se === null) { return; }
  var s = Math.min(ss, se), e = Math.max(ss, se);
  rv.push({start:s, end:e});
  localStorage.setItem('trackEditor_removals', JSON.stringify(rv));
  var del = rv.reduce(function(a, r) { return a + r.end - r.start + 1; }, 0);
  document.getElementById('delPts').textContent = del;
  document.getElementById('finalPts').textContent = P.length - del;
  var rl = L.polyline(pts.slice(s, e + 1), {color: '#ef4444', weight: 6, opacity: 0.7}).addTo(mm);
  removedLines.push(rl);
  rl._delInfo = {start: s, end: e};
  updateSelInfo(null, null);
  clearSel();
  refreshDelList();
};


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


// Upload modal handler
document.addEventListener('DOMContentLoaded', function() {
  var form = document.getElementById('uploadForm');
  if (!form) return;
  
  form.onsubmit = async function(e) {
    e.preventDefault();
    var st = document.getElementById('uploadStatus');
    st.innerHTML = '⏳ 正在上传处理...';
    st.style.color = '#94a3b8';
    var fd = new FormData(this);
    try {
      var r = await fetch('/upload', {method:'POST', body:fd});
      var d = await r.json();
      if (d.success) {
        st.innerHTML = '✅ ' + d.message;
        st.style.color = '#22c55e';
        setTimeout(function() {
          document.getElementById('uploadModal').style.display = 'none';
          location.reload();
        }, 1500);
      } else {
        st.innerHTML = '❌ 失败: ' + d.error;
        st.style.color = '#ef4444';
      }
    } catch(e) {
      st.innerHTML = '❌ 网络错误: ' + e.message;
      st.style.color = '#ef4444';
    }
  };
});
