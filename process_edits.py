#!/usr/bin/env python3
"""Background process to apply edits. This is slow (345MB KMZ) so runs separately."""
import os, sys, json, traceback
import xml.etree.ElementTree as ET
import zipfile, shutil

DIR = os.path.dirname(os.path.abspath(__file__))
ns = 'http://www.opengis.net/kml/2.2'
gx_ns = 'http://www.google.com/kml/ext/2.2'
ET.register_namespace('', ns)
ET.register_namespace('gx', gx_ns)

ORIG_KMZ = '/home/yinjie/下载/20260514_103430.kmz'

def main():
    # Read pending edits
    edits_path = os.path.join(DIR, 'pending_edits.json')
    if not os.path.exists(edits_path):
        print("No pending edits")
        return
    
    with open(edits_path) as f:
        info = json.load(f)
    
    if not info.get('removals'):
        print("No removals to apply")
        return
    
    removals = info['removals']
    print(f"Applying {len(removals)} removals...")
    
    # Parse merged KML
    kml_path = os.path.join(DIR, 'doc.kml')
    tree = ET.parse(kml_path)
    root = tree.getroot()
    
    track = root.find(f'.//{{{gx_ns}}}Track')
    whens = track.findall(f'{{{ns}}}when')
    coords = track.findall(f'{{{gx_ns}}}coord')
    print(f"Total points: {len(whens)}")
    
    removals.sort(key=lambda r: r['start'])
    keep = set(range(len(whens)))
    for r in removals:
        for i in range(r['start'], r['end'] + 1):
            keep.discard(i)
    keep = sorted(keep)
    print(f"Keeping {len(keep)} points")
    
    for child in list(track):
        track.remove(child)
    
    for i in keep:
        track.append(whens[i])
        track.append(coords[i])
    
    temp_dir = os.path.join(DIR, 'temp_out')
    os.makedirs(temp_dir, exist_ok=True)
    tree.write(os.path.join(temp_dir, 'doc.kml'), xml_declaration=True, encoding='UTF-8')
    
    out_kmz = os.path.join(DIR, 'edited_track.kmz')
    print(f"Creating KMZ: {out_kmz}")
    
    with zipfile.ZipFile(out_kmz, 'w', zipfile.ZIP_DEFLATED) as zout:
        with zipfile.ZipFile(ORIG_KMZ, 'r') as zin:
            for item in zin.infolist():
                if item.filename == 'doc.kml':
                    zout.write(os.path.join(temp_dir, 'doc.kml'), 'doc.kml')
                else:
                    zout.writestr(item, zin.read(item.filename))
    
    shutil.rmtree(temp_dir)
    os.remove(edits_path)
    print(f"Done! Output: {out_kmz}")

if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print(f"Error: {e}")
        traceback.print_exc()
        sys.exit(1)
