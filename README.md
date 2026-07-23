# VEC

VEC turns raster artwork and raster-in-SVG files into clean, layered,
editable SVG. Processing runs locally in the browser through Pyodide.

## Features

- PNG, WebP, and SVG input
- Automatic color reduction with manual palette controls
- Organic and geometric vectorization profiles
- Layered SVG assembly and export
- Pure-vector SVG passthrough without starting the compute runtime
- Self-intersection detection and cleanup for generated cubic paths
- Browser-based parallel processing with no upload service

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

## Repository layout

```text
apps/web/                  Next.js browser application and Pyodide worker
packages/core/pipeline/    Raster-to-vector processing stages
packages/core/pipeline_ext Path cleanup extensions
packages/core/tests/       Synthetic regression tests
```
