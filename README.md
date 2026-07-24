# VEC

VEC turns raster artwork and raster-in-SVG files into clean, layered,
editable SVG. Processing runs locally in the browser through Pyodide.

## Features

- PNG, WebP, and SVG input
- Automatic color reduction with manual palette controls
- Dominant-color consolidation that removes transition shades without shifting source colors
- Topology-aware palette cleanup that rejects fragmented antialias clusters while preserving contiguous shadow accents
- Balanced, Illustrated, Maximum Detail, and Geometric logo presets
- Per-layer Smooth, Faithful, and Geometric vectorization profiles
- Advanced controls for smoothing, curve precision, corner detection, tiny-curve cleanup, and minimum detail area
- Optional second and third refinement passes driven by the previous SVG, with source-mask gap closing and controlled edge refitting
- Intuitive Straight, Curved, and Rounded edge-character choices for refinement passes, backed by line snapping, organic spline fitting, or circular-arc regularization
- Guided Source, Colors, Shape, and Export workflow with a live full-stage progress overlay and optional technical diagnostics
- Configurable palette-order or size-aware component stacking
- Stroke-free SVG export with disconnected accents split into editor-selectable objects
- Hole-aware component grouping so counters remain transparent
- Pure-vector SVG passthrough preserves paths and basic shapes, inherited fills, strokes, gradient paint definitions, round caps and joins, and rounded rectangles without starting the compute runtime
- Self-intersection detection and cleanup for generated cubic paths
- Browser-based parallel processing with no upload service
- Persistent four-worker Pyodide pool reused across uploads and refinement passes
- Scale-aware fidelity verification at every supported output resolution

## Privacy

VEC processes artwork in the browser. This repository contains no customer
artwork, customer names, production logos, or private project fixtures.
Regression coverage uses synthetic geometry.

## Local development

The web application requires Node.js 20 or newer:

```bash
cd apps/web
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Verification

Run the Python regression tests:

```bash
py -3.9 -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt
./.venv/Scripts/python.exe -m pytest packages/core/tests -q
```

Build the production web application:

```bash
cd apps/web
npm ci
npm run build
```

## Vercel deployment

The root `vercel.json` uses Vercel's framework-neutral preset to build the
Next.js static export in `apps/web`, even when the repository root is selected
in the dashboard. This avoids root-level Python and Next.js auto-detection.
Alternatively, set the Vercel project Root Directory to `apps/web` and use
the Next.js framework preset.

## Repository layout

```text
apps/web/                  Next.js browser application and Pyodide worker
packages/core/pipeline/    Raster-to-vector processing stages
packages/core/pipeline_ext Path cleanup extensions
packages/core/tests/       Synthetic regression tests
```
