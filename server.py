#!/usr/bin/env python3
"""Track Editor — Flask backend"""
import os, sys, json, traceback, glob, re, shutil, tempfile, zipfile
from urllib.parse import unquote
from flask import Flask, request, jsonify, send_file, send_from_directory, abort

import process_edits_v2 as edit_mod

app = Flask(__name__)
PORT = 8899
DIR = os.path.dirname(os.path.abspath(__file__))
ORIG_KMZ = os.path.join(DIR, 'original.kmz')

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.mp4': 'video/mp4',
}


# ── Startup cleanup ──────────────────────────────────────────

def clean_temp_files():
    for pattern in ['*.tmp', 'temp_out*', 'edited_track*', 'pending_edits.json', 'edit_errors.log']:
        for f in glob.glob(os.path.join(DIR, pattern)):
            try:
                os.remove(f)
            except:
                pass
    files_dir = os.path.join(DIR, 'files')
    if os.path.isdir(files_dir):
        wp_path = os.path.join(DIR, 'waypoints.json')
        keep = set()
        if os.path.exists(wp_path):
            try:
                with open(wp_path, encoding='utf-8') as f:
                    for wp in json.load(f):
                        for m in wp.get('media', []):
                            keep.add(os.path.basename(m))
                            keep.add(m.replace('files/', ''))
            except:
                pass
        for fname in os.listdir(files_dir):
            if fname not in keep:
                try:
                    os.remove(os.path.join(files_dir, fname))
                except:
                    pass

clean_temp_files()


# ── KMZ import ───────────────────────────────────────────────

def rebuild_from_kmz(kmz_path):
    try:
        with zipfile.ZipFile(kmz_path, 'r') as z:
            if 'doc.kml' not in z.namelist():
                return None
            kml = z.read('doc.kml').decode('utf-8', errors='replace')
    except:
        return None

    name_match = re.search(r'<name>(.*?)</name>', kml)
    track_name = name_match.group(1).strip() if name_match else '未命名轨迹'

    tracks = re.findall(r'<gx:Track>.*?</gx:Track>', kml, re.DOTALL)
    if not tracks:
        return None

    points = []
    idx = 0
    for track in tracks:
        whens = re.findall(r'<when>(.*?)</when>', track)
        coords = re.findall(r'<gx:coord>(.*?)</gx:coord>', track)
        min_len = min(len(whens), len(coords))
        for i in range(min_len):
            parts = coords[i].strip().split()
            if len(parts) >= 2:
                lng, lat = parts[0], parts[1]
                alt = float(parts[2]) if len(parts) > 2 else 0.0
                points.append([idx, float(lat), float(lng), alt, whens[i]])
                idx += 1

    if not points:
        return None

    json_path = os.path.join(DIR, 'track_data.json')
    with open(json_path, 'w') as f:
        json.dump(points, f)

    shutil.copy2(kmz_path, ORIG_KMZ)

    for fname in ['edited_track.kmz', 'edited_track_v2.kmz', 'pending_edits.json']:
        fpath = os.path.join(DIR, fname)
        if os.path.exists(fpath):
            os.remove(fpath)

    meta = {'name': 'track.kmz'}
    if track_name:
        meta['displayName'] = track_name
    with open(os.path.join(DIR, 'upload_meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)

    desc_match = re.search(r'<description>(.*?)</description>', kml, re.DOTALL)
    doc_desc = ''
    if desc_match:
        doc_desc = desc_match.group(1).strip()
        for e, r in [('&lt;', '<'), ('&gt;', '>'), ('&amp;', '&'), ('&quot;', '"')]:
            doc_desc = doc_desc.replace(e, r)
        doc_desc = doc_desc.replace('<![CDATA[', '').replace(']]>', '')
    with open(os.path.join(DIR, 'track_info.json'), 'w', encoding='utf-8') as f:
        json.dump({'desc': doc_desc}, f, ensure_ascii=False)

    _extract_waypoints_and_media(kmz_path, kml)
    return '已加载 "' + track_name + '"（' + str(len(points)) + ' 个轨迹点）'


def _extract_waypoints_and_media(kmz_path, kml):
    waypoints = []
    media_refs = set()

    for pm in re.findall(r'<Placemark[^>]*>.*?</Placemark>', kml, re.DOTALL):
        if '<gx:Track>' in pm or '<Point>' not in pm:
            continue

        name_m = re.search(r'<name>(.*?)</name>', pm, re.DOTALL)
        desc_m = re.search(r'<description>(.*?)</description>', pm, re.DOTALL)
        coord_m = re.search(r'<coordinates>(.*?)</coordinates>', pm, re.DOTALL)

        name = name_m.group(1).strip() if name_m else '未命名'
        desc = ''
        if desc_m:
            desc = desc_m.group(1).strip()
            for e, r in [('&lt;', '<'), ('&gt;', '>'), ('&amp;', '&'), ('&quot;', '"')]:
                desc = desc.replace(e, r)
            desc = desc.replace('<![CDATA[', '').replace(']]>', '')

        lat = lng = alt = 0
        if coord_m:
            parts = coord_m.group(1).strip().split(',')
            if len(parts) >= 2:
                lng, lat = float(parts[0]), float(parts[1])
                alt = float(parts[2]) if len(parts) > 2 else 0

        wp_media = []
        for m in re.finditer(r'<img[^>]+src="([^"]+)"', desc):
            wp_media.append(m.group(1))
            media_refs.add(m.group(1))
        for m in re.finditer(r'<embed[^>]+src="([^"]+)"', desc):
            wp_media.append(m.group(1))
            media_refs.add(m.group(1))

        waypoints.append({'name': name, 'lat': lat, 'lng': lng, 'alt': alt, 'desc': desc, 'media': wp_media})

    with open(os.path.join(DIR, 'waypoints.json'), 'w', encoding='utf-8') as f:
        json.dump(waypoints, f, ensure_ascii=False, indent=2)

    files_dir = os.path.join(DIR, 'files')
    os.makedirs(files_dir, exist_ok=True)
    with zipfile.ZipFile(kmz_path, 'r') as z:
        for ref in media_refs:
            target = os.path.join(DIR, ref)
            try:
                data = z.read(ref)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, 'wb') as f:
                    f.write(data)
            except KeyError:
                pass


# ── Helpers ──────────────────────────────────────────────────

def send_json(data, status=200):
    resp = jsonify(data)
    resp.status_code = status
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp


def safe_path(filename):
    """Resolve a filename under DIR, rejecting path traversal."""
    fpath = os.path.normpath(os.path.join(DIR, filename))
    if not fpath.startswith(DIR) or not os.path.isfile(fpath):
        abort(404)
    return fpath


# ── Routes ───────────────────────────────────────────────────

@app.after_request
def add_cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp


@app.route('/')
def index():
    return send_from_directory(DIR, 'index.html')


@app.route('/<path:filename>')
def static_serve(filename):
    """Serve static files (JS, CSS, JSON, etc.) — excludes /download subtree."""
    fpath = safe_path(filename)
    ext = os.path.splitext(filename)[1].lower()
    mimetype = MIME.get(ext)
    resp = send_file(fpath, mimetype=mimetype)
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp


@app.route('/download/<filename>')
def download(filename):
    """Stream a KMZ file for download with attachment disposition."""
    fname = unquote(os.path.basename(filename))
    fpath = os.path.join(DIR, fname)
    if not os.path.isfile(fpath):
        abort(404)
    return send_file(fpath, mimetype='application/vnd.google-earth.kmz',
                     as_attachment=True, download_name=fname)


@app.route('/upload', methods=['POST'])
def upload_kmz():
    if 'file' not in request.files:
        return send_json({'success': False, 'error': '请选择 KMZ 文件'}, 400)
    f = request.files['file']
    if not f.filename or not f.filename.lower().endswith('.kmz'):
        return send_json({'success': False, 'error': '请上传 .kmz 文件'}, 400)

    raw = f.read()
    if not raw[:2] == b'PK':
        return send_json({'success': False, 'error': '文件格式错误，请上传有效的 KMZ 文件'}, 400)

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.kmz', dir=DIR)
    tmp.write(raw)
    tmp.close()

    try:
        msg = rebuild_from_kmz(tmp.name)
        if msg:
            return send_json({'success': True, 'message': msg})
        return send_json({'success': False, 'error': '处理 KMZ 失败，请检查是否为两步路导出的轨迹文件'}, 500)
    except Exception as e:
        return send_json({'success': False, 'error': str(e), 'traceback': traceback.format_exc()}, 500)
    finally:
        os.unlink(tmp.name)


@app.route('/upload-file', methods=['POST'])
def upload_file():
    saved = []
    for f in request.files.getlist('file') or [request.files.get('file')]:
        if not f or not f.filename:
            continue
        safe = os.path.basename(f.filename)
        if not safe:
            continue
        target = os.path.join(DIR, 'files', safe)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        f.save(target)
        saved.append(safe)

    if saved:
        return send_json({'success': True, 'message': f'已保存 {len(saved)} 个文件'})
    return send_json({'success': False, 'error': '未找到文件内容'}, 400)


@app.route('/api/rename', methods=['POST'])
def rename():
    data = request.get_json(silent=True) or {}
    new_name = data.get('name', '').strip()
    if not new_name:
        return send_json({'success': False, 'error': '名称不能为空'}, 400)
    meta_path = os.path.join(DIR, 'upload_meta.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r', encoding='utf-8') as f:
            meta = json.load(f)
    else:
        meta = {'name': 'track.kmz'}
    meta['displayName'] = new_name
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False)
    return send_json({'success': True, 'name': new_name})


@app.route('/api/apply-edits', methods=['POST'])
def apply_edits():
    data = request.get_json(silent=True) or {}
    try:
        out_path = edit_mod.run_edits(
            data.get('removals', []),
            data.get('wpDeleted', []),
            data.get('wpEdited', {})
        )
        out_name = os.path.basename(out_path)
        return send_json({
            'success': True,
            'message': '编辑完成',
            'downloadUrl': '/download/' + out_name,
            'ready': True
        })
    except Exception as e:
        return send_json({
            'success': False,
            'error': str(e),
            'traceback': traceback.format_exc()
        }, 500)


@app.route('/status')
def status():
    edited_exists = os.path.exists(os.path.join(DIR, 'edited_track.kmz'))
    return send_json({'ready': edited_exists})


# ── Entrypoint ───────────────────────────────────────────────

if __name__ == '__main__':
    print(f'🚀 Track Editor: http://0.0.0.0:{PORT}')
    print(f'   Local: http://127.0.0.1:{PORT}')
    print(f'   Network: http://192.168.3.10:{PORT}')
    app.run(host='0.0.0.0', port=PORT, threaded=True, use_reloader=False)
