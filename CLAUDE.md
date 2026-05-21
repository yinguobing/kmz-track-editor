# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Start the dev server**: `python3 server.py` (runs on http://0.0.0.0:8899)
- No build step, test suite, or linter exists.

## Architecture

A single-page track editor for editing KMZ trajectory files exported from the 两步路 (2bulu) app. Flask backend + vanilla JS frontend with Leaflet maps.

### Backend (`server.py`)

Flask server on port 8899. Key routes:

| Route | Purpose |
|---|---|
| `POST /upload` | Accept a .kmz file, parse `doc.kml` to extract track points → `track_data.json`, waypoints → `waypoints.json`, media → `files/`, save as `original.kmz` |
| `POST /api/apply-edits` | Receives `{removals, wpDeleted, wpEdited}`, calls `edit_processor.run_edits()` to produce an edited .kmz, returns download URL |
| `POST /api/rename` | Update the track's display name in `upload_meta.json` |
| `POST /upload-file` | Upload arbitrary media files to `files/` |
| `GET /download/<filename>` | Serve generated .kmz as attachment download |

Static files are served from the project root. `safe_path()` prevents directory traversal.

### Edit Processing (`edit_processor.py`)

`run_edits(removals, wpDeleted, wpEdited)` reads `original.kmz`, parses its `doc.kml` with `xml.etree.ElementTree`, and:

1. Finds all `<gx:Track>` segments, maps global point indices to per-segment local indices
2. Removes `<when>`/`<gx:coord>` pairs from each segment for points in deletion ranges
3. Removes waypoint `<Placemark>` elements (those with `<Point>` but no `<gx:Track>`)
4. Applies waypoint name edits
5. Rebuilds the .kmz zip, including separately uploaded media from `files/`

Handles two KML formats: alternating `<when><coord><when><coord>` and block `<when>...<when><coord>...<coord>`.

### Frontend (`templates/index.html` + `static/js/editor.js`)

All HTML and CSS is in `templates/index.html`. The JS (`static/js/editor.js`) is an IIFE module with these subsystems:

- **Map**: Leaflet with two tile layers — Esri satellite (+ labels overlay) and OpenStreetMap. Switched via buttons in `.map-tools`.
- **Track rendering**: `L.polyline` from `track_data.json` points. Hover nearest-point detection (throttled to 100ms, 60m threshold). Click-first-point-then-second-point to select a range for deletion.
- **Deletion workflow**: Two clicks select start/end → yellow highlight + popup with "删除"/"重置" buttons → confirm adds a gray overlay polyline and pushes to `removals[]`. Deletions persisted in `localStorage` (`trackEditor_removals`).
- **Waypoints**: Diamond-shaped `L.divIcon` markers. Popup with edit-name / delete buttons. Edits persisted in `localStorage` (`trackEditor_wpEdits`).
- **File info card**: Shows track name (click to rename), date, total/effective distance (Haversine), point count, waypoint count. Values struck-through and replaced when edits exist.
- **Export**: POSTs removals + wpDeleted + wpEdited to `/api/apply-edits`, then triggers download of the returned .kmz.
- **Drag & drop**: KMZ files can be dropped anywhere on the map to upload (reloads page on success).
- **Event handling**: All UI actions use delegated `data-action` attributes on the document rather than inline `onclick`.

### Data files (generated at runtime, in `.gitignore`)

| File | Content |
|---|---|
| `track_data.json` | `[[idx, lat, lng, alt, time], ...]` |
| `waypoints.json` | `[{name, lat, lng, alt, desc, media}, ...]` |
| `track_info.json` | `{desc: "..."}` from KML `<description>` |
| `upload_meta.json` | `{name, displayName}` |
| `original.kmz` | The uploaded source file |

### Vendored dependencies

`static/lib/leaflet.js` and `static/lib/leaflet.css` — Leaflet 1.x (no package manager).

## Design conventions

- CSS custom properties define a dark "mountain wilderness" theme: `--canvas` (bg), `--surface`/`--surface-soft` (cards), `--coral`/`--peach`/`--cream` (accents), `--border`/`--border-strong` (borders).
- Chinese UI (zh-CN). User-facing strings are in Chinese.
- The panel overlays the map (`position: absolute`) rather than using a sidebar layout.
- `static/js/editor.js` uses `var` throughout (pre-ES6 style) and avoids any build tooling.
- Point indices are global across all `<gx:Track>` segments — the edit processor maps them back to per-segment local indices.
