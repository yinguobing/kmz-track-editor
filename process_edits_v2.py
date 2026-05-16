#!/usr/bin/env python3
"""
Process edits on the ORIGINAL multi-segment KML structure.
Reads pending_edits.json, applies deletions to each segment,
and produces a new doc.kml that preserves the 10-segment structure.
"""
import os, sys, json, traceback, shutil, copy, zipfile
import xml.etree.ElementTree as ET

DIR = os.path.dirname(os.path.abspath(__file__))
ns = 'http://www.opengis.net/kml/2.2'
gx_ns = 'http://www.google.com/kml/ext/2.2'
ET.register_namespace('', ns)
ET.register_namespace('gx', gx_ns)

ORIG_KMZ = os.path.join(DIR, 'original.kmz')

def get_segment_boundaries(orig_kml):
    """Get global index ranges for each gx:Track segment."""
    root = ET.fromstring(orig_kml)
    doc = root.find(f'{{{ns}}}Document')
    tracks = doc.findall(f'.//{{{gx_ns}}}Track')
    
    start = 0
    segments = []
    for t in tracks:
        whens = t.findall(f'{{{ns}}}when')
        count = len(whens)
        segments.append({
            'start': start,
            'end': start + count - 1,
            'count': count,
            'element': t
        })
        start += count
    return segments, root

def apply_removals_to_segment(track, keep_indices_within_seg):
    """Remove when/coord pairs from a gx:Track element that are not in keep_indices.
    
    Handles both formats:
      Format A (alternating): <when><coord><when><coord>...
      Format B (block): <when>...<when><coord>...<coord>
    """
    import re as _re
    # Get all when and gx:coord elements
    whens = track.findall(f'{{{ns}}}when')
    coords = track.findall(f'{{{gx_ns}}}coord')
    
    if not whens or not coords:
        return 0  # empty track, skip
    
    original_count = len(whens)
    keep_set = set(keep_indices_within_seg)
    
    children = list(track)
    
    # Detect format: check the first few elements
    first_when_idx = None
    first_coord_idx = None
    for i, child in enumerate(children):
        tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
        if tag == 'when' and first_when_idx is None:
            first_when_idx = i
        if tag == 'coord' and first_coord_idx is None:
            first_coord_idx = i
        if first_when_idx is not None and first_coord_idx is not None:
            break
    
    is_alternating = abs(first_coord_idx - first_when_idx) == 1
    
    # Remove elements not in keep_set, iterating in reverse order
    if is_alternating:
        # Format A: alternating <when><coord><when><coord>
        data_start = 0
        for i, child in enumerate(children):
            tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag == 'when':
                data_start = i
                break
        pairs = (len(children) - data_start) // 2
        removed = 0
        for i in range(pairs - 1, -1, -1):
            if i not in keep_set:
                coord_idx = data_start + i * 2 + 1
                when_idx = data_start + i * 2
                track.remove(children[coord_idx])
                track.remove(children[when_idx])
                removed += 1
        remaining = original_count - removed
    else:
        # Format B: all whens first, then all coords
        # Whens are at 0..N-1, coords at N..2N-1
        removed = 0
        for i in range(original_count - 1, -1, -1):
            if i not in keep_set:
                # Remove coord first, then when (reverse order to keep indices valid)
                track.remove(coords[i])
                track.remove(whens[i])
                removed += 1
        remaining = original_count - removed
    
    return remaining

def main():
    edits_path = os.path.join(DIR, 'pending_edits.json')
    if not os.path.exists(edits_path):
        print("No pending edits")
        return
    
    with open(edits_path) as f:
        info = json.load(f)
    
    removals = info.get('removals', [])
    if not removals:
        print("No removals to apply, copying original")
        # Just copy the original as output
        meta_path = os.path.join(DIR, 'upload_meta.json')
        meta = {}
        if os.path.exists(meta_path):
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
            except:
                pass
        base = meta.get('name', 'edited_track.kmz').replace('.kmz', '_edited.kmz')
        out_kmz = os.path.join(DIR, base)
        shutil.copy2(ORIG_KMZ, out_kmz)
        os.remove(edits_path)
        print(f"Copied original to {out_kmz}")
        return
    
    print(f"Applying {len(removals)} removal ranges...")
    
    # Read original KML from the KMZ
    with zipfile.ZipFile(ORIG_KMZ, 'r') as z:
        orig_kml = z.read('doc.kml').decode('utf-8')
    
    # Auto-fix missing namespace declarations
    ns_fixes = {
        'xmlns:atom': 'http://www.w3.org/2005/Atom',
        'xmlns:ns1': 'http://www.w3.org/2005/Atom',
    }
    for prefix, ns_url in ns_fixes.items():
        if prefix not in orig_kml:
            # Find the kml tag and add the declaration
            import re as _r
            orig_kml = orig_kml.replace('<kml ', f'<kml {prefix}="{ns_url}" ')
    
    # Get segment boundaries
    segments, root = get_segment_boundaries(orig_kml)
    total_pts = sum(s['count'] for s in segments)
    print(f"Original: {total_pts} points in {len(segments)} segments")
    
    # Build set of all global indices to delete
    delete_set = set()
    for r in removals:
        for i in range(r['start'], r['end'] + 1):
            delete_set.add(i)
    
    print(f"Removing {len(delete_set)} points")
    
    # For each segment, determine which local indices to keep
    total_kept = 0
    for seg in segments:
        seg_indices = set(range(seg['count']))
        # Which global indices in this segment are to be deleted?
        seg_global = range(seg['start'], seg['end'] + 1)
        seg_delete = {g - seg['start'] for g in seg_global if g in delete_set}
        seg_keep = seg_indices - seg_delete
        
        if seg_delete:
            remaining = apply_removals_to_segment(seg['element'], seg_keep)
            print(f"  Segment: global {seg['start']}~{seg['end']}: kept {remaining}/{seg['count']}")
            total_kept += remaining
        else:
            total_kept += seg['count']
    
    print(f"Total remaining: {total_kept} points")
    
    # Write the new doc.kml
    temp_dir = os.path.join(DIR, 'temp_out_v2')
    os.makedirs(temp_dir, exist_ok=True)
    tree = ET.ElementTree(root)
    tree.write(os.path.join(temp_dir, 'doc.kml'), xml_declaration=True, encoding='UTF-8')
    
    # Create new KMZ
    # Determine output filename from original
    meta_path = os.path.join(DIR, 'upload_meta.json')
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except:
            pass
    base = meta.get('name', 'edited_track.kmz').replace('.kmz', '_edited.kmz')
    out_kmz = os.path.join(DIR, base)
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
