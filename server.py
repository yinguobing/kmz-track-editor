#!/usr/bin/env python3
import os, sys, json, traceback, subprocess, time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

PORT = 8899
DIR = os.path.dirname(os.path.abspath(__file__))

MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
}


import shutil, tempfile, re
ORIG_KMZ = '/home/yinjie/下载/20260514_103430.kmz'

def rebuild_from_kmz(kmz_path, orig_filename=None):
    """Extract track data from KMZ and save as track_data.json. No HTML patching needed."""
    import zipfile
    try:
        with zipfile.ZipFile(kmz_path, 'r') as z:
            if 'doc.kml' not in z.namelist():
                return None
            kml = z.read('doc.kml').decode('utf-8', errors='replace')
    except:
        return None
    
    # Find track name
    name_match = re.search(r'<name>(.*?)</name>', kml)
    track_name = name_match.group(1).strip() if name_match else '未命名轨迹'
    
    # Extract all gx:coord and when pairs
    # Handle two formats: alternating when/coord and block format (all whens then all coords)
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
    
    # Save as JSON
    json_path = os.path.join(DIR, 'track_data.json')
    with open(json_path, 'w') as f:
        json.dump(points, f)
    
    # Also copy the uploaded KMZ as new original
    shutil.copy2(kmz_path, ORIG_KMZ)
    
    # Clear old edited files
    for fname in ['edited_track.kmz', 'edited_track_v2.kmz', 'pending_edits.json']:
        fpath = os.path.join(DIR, fname)
        if os.path.exists(fpath):
            os.remove(fpath)
    
    # Save original filename for download naming
    meta_path = os.path.join(DIR, 'upload_meta.json')
    save_name = orig_filename or os.path.basename(kmz_path)
    with open(meta_path, 'w') as f:
        json.dump({'name': save_name}, f)
    
    return '已加载 "' + track_name + '"（' + str(len(points)) + ' 个轨迹点）'

def get_orig_filename():
    '''Get the original uploaded KMZ filename from saved metadata.'''
    meta_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'upload_meta.json')
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            return meta.get('name', 'edited_track.kmz')
        except:
            pass
    return 'edited_track.kmz'

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[S] {fmt % args}\n")
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()
    
    def do_POST_upload(self, path):
        """Handle KMZ file upload via multipart POST to /upload"""
        try:
            import cgi
            ctype, pdict = cgi.parse_header(self.headers.get('Content-Type', ''))
            if ctype != 'multipart/form-data':
                self._send_json(400, {'success': False, 'error': 'Expected multipart/form-data'})
                return

            boundary = self.headers.get('Content-Type', '').split('boundary=')[-1].strip()
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            
            # Find the KMZ file part in the multipart body
            boundary_bytes = f'--{boundary}'.encode()
            parts = body.split(boundary_bytes)
            
            kmz_data = None
            for part in parts:
                if b'filename=' in part and (b'.kmz' in part or b'application' in part):
                    # Find the double newline that separates headers from content
                    idx = part.find(b'\r\n\r\n')
                    if idx > 0:
                        content_start = idx + 4
                        # Remove trailing newlines and boundary end
                        kmz_data = part[content_start:].rstrip(b'\r\n- \t')
                        break
            
            if not kmz_data:
                self._send_json(400, {'success': False, 'error': '请选择 KMZ 文件'})
                return
            
            # Extract original filename from multipart headers
            orig_name = 'uploaded.kmz'
            for part in parts:
                if b'filename=' in part:
                    fn_match = re.search(b'filename="([^"]*)"', part)
                    if fn_match:
                        orig_name = fn_match.group(1).decode('utf-8', errors='replace')
                        break
            
            # Save to temp file
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.kmz', dir=DIR)
            tmp.write(kmz_data)
            tmp.close()
            tmp_path = tmp.name
            
            proc_result = rebuild_from_kmz(tmp_path, orig_name)
            os.unlink(tmp_path)
            
            if proc_result:
                self._send_json(200, {'success': True, 'message': proc_result})
            else:
                self._send_json(500, {'success': False, 'error': '处理 KMZ 失败，请检查是否为两步路导出的轨迹文件'})
        except Exception as e:
            self._send_json(500, {'success': False, 'error': str(e), 'traceback': traceback.format_exc()})
    
    def _send_json(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def do_POST(self):
        # Route to upload handler for /upload path
        parsed = urlparse(self.path)
        if parsed.path == '/upload':
            self.do_POST_upload(parsed.path)
            return

        try:
            length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(length)
            data = json.loads(body)
            removals = data.get('removals', [])
            total_pts = data.get('totalPts', 3373)
            
            # Save the removals to a temp file for the background process
            info = {
                'removals': removals,
                'totalPts': total_pts,
                'timestamp': time.time(),
                'origFilename': get_orig_filename()
            }
            with open(os.path.join(DIR, 'pending_edits.json'), 'w') as f:
                json.dump(info, f)
            
            # Run the edit script in background (takes time for 345MB KMZ)
            subprocess.Popen(
                [sys.executable, os.path.join(DIR, 'process_edits_v2.py')],
                cwd=DIR
            )
            
            # Immediately respond that the edit is queued
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': True,
                'message': '编辑已提交，请稍后点击下载按钮',
                'downloadUrl': '/download/' + get_orig_filename().replace('.kmz', '_edited.kmz'),
                'ready': False
            }).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'success': False, 'error': str(e),
                'traceback': traceback.format_exc()
            }).encode())
    
    def do_GET(self):
        path = urlparse(self.path).path
        
        if path.startswith('/download/'):
            fname = os.path.basename(path)
            fpath = os.path.join(DIR, fname)
            if os.path.exists(fpath):
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.google-earth.kmz')
                self.send_header('Content-Disposition', f'attachment; filename="{fname}"')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                with open(fpath, 'rb') as f:
                    self.wfile.write(f.read())
                return
            self.send_error(404)
            return
        
        if path == '/upload':
            # Serve upload page
            upload_path = os.path.join(DIR, 'upload_page.html')
            if os.path.exists(upload_path):
                with open(upload_path, 'rb') as f:
                    html = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.end_headers()
                self.wfile.write(html)
            else:
                self.send_error(404)
            return
        
        if path == '/status':
            edited_exists = os.path.exists(os.path.join(DIR, 'edited_track.kmz'))
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({
                'ready': edited_exists
            }).encode())
            return
        
        if path == '/' or path == '':
            path = '/index.html'
        
        fpath = os.path.join(DIR, path.lstrip('/'))
        fpath = os.path.normpath(fpath)
        
        if not fpath.startswith(DIR) or not os.path.isfile(fpath):
            self.send_error(404)
            return
        
        ext = os.path.splitext(fpath)[1].lower()
        self.send_response(200)
        self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        with open(fpath, 'rb') as f:
            self.wfile.write(f.read())


if __name__ == '__main__':
    server = HTTPServer(('0.0.0.0', PORT), Handler)
    print(f'🚀 Track Editor: http://0.0.0.0:{PORT}')
    print(f'   Local: http://127.0.0.1:{PORT}')
    print(f'   Network: http://192.168.3.10:{PORT}')
    server.serve_forever()
