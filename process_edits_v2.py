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

def fix_kml_namespaces(kml_str):
    """Add missing namespace declarations that some KMZ files lack."""
    ns_fixes = {
        'xmlns:atom': 'http://www.w3.org/2005/Atom',
        'xmlns:ns1': 'http://www.w3.org/2005/Atom',
    }
    for prefix, ns_url in ns_fixes.items():
        if prefix not in kml_str:
            kml_str = kml_str.replace('<kml ', f'<kml {prefix}="{ns_url}" ')
    return kml_str


def apply_wp_changes(root, wpDeleted, wpEdited):
    """Remove deleted waypoints and apply name edits.
    
    Both wpDeleted and wpEdited keys use ORIGINAL waypoint indices
    (matching the waypoints.json order).
    """
    doc = root.find(f'{{{ns}}}Document')
    if doc is None:
        return
    # Use recursive search (.//) because waypoints may be inside <Folder> elements
    # Collect (parent, placemark, original_index) for waypoint Placemarks
    # The order they appear in the KML is the original index order
    wp_items = []  # [(parent, elem, original_idx), ...]
    for container in doc.iter():
        tag_short = container.tag.split('}')[-1] if '}' in container.tag else container.tag
        if tag_short not in ('Document', 'Folder'):
            continue
        for child in list(container):
            tag_short2 = child.tag.split('}')[-1] if '}' in child.tag else child.tag
            if tag_short2 != 'Placemark':
                continue
            point_elem = child.find(f'{{{ns}}}Point')
            track_elem = child.find(f'{{{gx_ns}}}Track')
            if point_elem is not None and track_elem is None:
                wp_items.append((container, child, len(wp_items)))
    
    delete_set = set(wpDeleted) if wpDeleted else set()
    
    # Remove deleted waypoints (reverse order for stable indices)
    for idx in range(len(wp_items) - 1, -1, -1):
        parent, elem, orig_idx = wp_items[idx]
        if orig_idx in delete_set:
            parent.remove(elem)
            print(f"  Removed waypoint #{orig_idx}")
    
    # Apply name edits by original index
    if wpEdited:
        for i_str, edit_info in wpEdited.items():
            orig_idx = int(i_str)
            if orig_idx in delete_set:
                continue  # already deleted, skip
            new_name = edit_info.get('name', '').strip()
            if not new_name:
                continue
            # Find the waypoint with this original index (skip deleted ones)
            for parent, elem, oi in wp_items:
                if oi == orig_idx:
                    name_elem = elem.find(f'{{{ns}}}name')
                    if name_elem is not None:
                        old_name = name_elem.text or ''
                        name_elem.text = new_name
                        print(f'  Renamed waypoint #{orig_idx}: "{old_name}" → "{new_name}"')
                    else:
                        # Create <name> element as first child of Placemark
                        name_elem = ET.SubElement(elem, f'{{{ns}}}name')
                        name_elem.text = new_name
                        # Move to first position (before description)
                        elem.remove(name_elem)
                        elem.insert(0, name_elem)
                        print(f'  Added name for waypoint #{orig_idx}: "{new_name}"')


def run_edits(removals, wpDeleted, wpEdited=None):
    """Apply edits to the original KMZ and produce the output file.
    Returns output_filename.
    """
    if wpEdited is None:
        wpEdited = {}
    # Get media to skip (from deleted waypoints)
    skip_media = set()
    wp_path = os.path.join(DIR, 'waypoints.json')
    if wpDeleted and os.path.exists(wp_path):
        try:
            with open(wp_path, encoding='utf-8') as f:
                wps = json.load(f)
            for idx in wpDeleted:
                if idx < len(wps):
                    for m in wps[idx].get('media', []):
                        skip_media.add(os.path.basename(m))
        except:
            pass
    
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
        out_tmp = out_kmz + '.tmp'
        # Rebuild zip filtering out media and deleted waypoints
        # Pre-parse KML to remove deleted waypoints if any
        wp_modified_kml = None
        if wpDeleted or wpEdited:
            try:
                with zipfile.ZipFile(ORIG_KMZ, 'r') as _z:
                    orig_kml = _z.read('doc.kml').decode('utf-8')
                orig_kml = fix_kml_namespaces(orig_kml)
                root = ET.fromstring(orig_kml)
                apply_wp_changes(root, wpDeleted, wpEdited)
                tree = ET.ElementTree(root)
                import io
                buf = io.BytesIO()
                tree.write(buf, xml_declaration=True, encoding='UTF-8')
                wp_modified_kml = buf.getvalue()
            except Exception as e:
                print(f"Warning: failed to remove waypoints: {e}")
        with zipfile.ZipFile(ORIG_KMZ, 'r') as zin:
            with zipfile.ZipFile(out_tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    base = os.path.basename(item.filename)
                    if base in skip_media:
                        continue
                    if item.filename == 'doc.kml' and wp_modified_kml is not None:
                        zout.writestr(item, wp_modified_kml)
                    else:
                        zout.writestr(item, zin.read(item.filename))
        # Also add media files from files/ directory
        files_dir = os.path.join(DIR, 'files')
        if os.path.isdir(files_dir):
            added = 0
            with zipfile.ZipFile(out_tmp, 'a', zipfile.ZIP_DEFLATED) as zout:
                existing = set(zout.namelist())
                for fname in os.listdir(files_dir):
                    arc_path = 'files/' + fname
                    if arc_path not in existing and fname not in skip_media:
                        zout.write(os.path.join(files_dir, fname), arc_path)
                        added += 1
            if added:
                print(f"Added {added} media files to output")
        os.replace(out_tmp, out_kmz)
        print(f"Copied original to {out_kmz}")
        return out_kmz
    
    print(f"Applying {len(removals)} removal ranges...")
    
    # Read original KML from the KMZ
    with zipfile.ZipFile(ORIG_KMZ, 'r') as z:
        orig_kml = z.read('doc.kml').decode('utf-8')
    
    # Auto-fix missing namespace declarations
    orig_kml = fix_kml_namespaces(orig_kml)
    
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
    
    # Apply waypoint changes (deletions + name edits)
    apply_wp_changes(root, wpDeleted, wpEdited)
    
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
    out_tmp = out_kmz + '.tmp'
    print(f"Creating KMZ: {out_kmz}")
    
    with zipfile.ZipFile(out_tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        # Copy files from original KMZ
        with zipfile.ZipFile(ORIG_KMZ, 'r') as zin:
            for item in zin.infolist():
                if item.filename == 'doc.kml':
                    zout.write(os.path.join(temp_dir, 'doc.kml'), 'doc.kml')
                else:
                    zout.writestr(item, zin.read(item.filename))
        
        # Also include any separately uploaded media files (videos etc.)
        files_dir = os.path.join(DIR, 'files')
        if os.path.isdir(files_dir):
            for fname in os.listdir(files_dir):
                arc_path = 'files/' + fname
                # Skip if already in the KMZ
                if arc_path not in set(zout.namelist()):
                    zout.write(os.path.join(files_dir, fname), arc_path)
    
    shutil.rmtree(temp_dir)
    os.replace(out_tmp, out_kmz)
    print(f"Done! Output: {out_kmz}")
    return out_kmz


def main():
    """CLI entry: reads pending_edits.json."""
    edits_path = os.path.join(DIR, 'pending_edits.json')
    if not os.path.exists(edits_path):
        print("No pending edits")
        return
    with open(edits_path) as f:
        info = json.load(f)
    removals = info.get('removals', [])
    wpDeleted = info.get('wpDeleted', [])
    wpEdited = info.get('wpEdited', {})
    try:
        run_edits(removals, wpDeleted, wpEdited)
    except Exception as e:
        print(f"Error: {e}")
        traceback.print_exc()
        sys.exit(1)
    finally:
        if os.path.exists(edits_path):
            os.remove(edits_path)


if __name__ == '__main__':
    main()
