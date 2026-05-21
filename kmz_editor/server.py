#!/usr/bin/env python3
"""Track Editor — Flask backend"""
import os, json, traceback, glob, tempfile
from urllib.parse import unquote
from flask import Flask, request, jsonify, send_file, send_from_directory, abort

from kmz_editor import edit_processor as edit_mod

app = Flask(__name__, static_folder=None)
PORT = 8899
from kmz_editor import ROOT
DIR = ROOT
STATIC = os.path.join(DIR, 'static')
TEMPLATES = os.path.join(DIR, 'templates')
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


# ── Helpers ──────────────────────────────────────────────────

def send_json(data, status=200):
    resp = jsonify(data)
    resp.status_code = status
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp



# ── Routes ───────────────────────────────────────────────────

@app.after_request
def add_cors(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    return resp


@app.route('/')
def index():
    return send_from_directory(TEMPLATES, 'index.html')


@app.route('/<path:filename>')
def static_serve(filename):
    """Serve static files (JS, CSS, JSON, etc.) — excludes /download subtree."""
    for base in [STATIC, TEMPLATES, DIR]:
        fpath = os.path.normpath(os.path.join(base, filename))
        if fpath.startswith(base) and os.path.isfile(fpath):
            break
    else:
        fpath = os.path.normpath(os.path.join(DIR, filename))
        if not fpath.startswith(DIR) or not os.path.isfile(fpath):
            abort(404)
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
        msg = edit_mod.extract_track_data(tmp.name)
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

def main():
    print(f'🚀 Track Editor: http://0.0.0.0:{PORT}')
    print(f'   Local: http://127.0.0.1:{PORT}')
    print(f'   Network: http://192.168.3.10:{PORT}')
    app.run(host='0.0.0.0', port=PORT, threaded=True, use_reloader=False)

if __name__ == '__main__':
    main()
