"use client";

import { useCallback, useRef, useState, useEffect } from "react";
import { assembleLayers, type AssembledLayer } from "@/lib/assemble";
import { parseSvgInput, compositeRasters, scalePathData, type VectorPath } from "@/lib/svgInput";
import { ComputePool, choosePoolSize } from "@/lib/pool";
import type { LayerJob, LayerResult, Profile } from "@/lib/types";

// Detect the background colour from an image's border (a logo's background is
// whatever dominates the edges). Returns null if the border is mostly transparent.
function detectBgRgb(data: Uint8ClampedArray, w: number, h: number): [number, number, number] | null {
  const buckets = new Map<string, { r: number; g: number; b: number; n: number }>();
  let transparent = 0, total = 0;
  const step = Math.max(1, Math.floor(Math.max(w, h) / 200));
  const at = (x: number, y: number) => {
    const i = (y * w + x) * 4; total++;
    if (data[i + 3] < 100) { transparent++; return; }
    const key = `${Math.round(data[i] / 24)},${Math.round(data[i + 1] / 24)},${Math.round(data[i + 2] / 24)}`;
    const b = buckets.get(key);
    if (b) { b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2]; }
    else buckets.set(key, { r: data[i], g: data[i + 1], b: data[i + 2], n: 1 });
  };
  for (let x = 0; x < w; x += step) { at(x, 0); at(x, h - 1); }
  for (let y = 0; y < h; y += step) { at(0, y); at(w - 1, y); }
  if (transparent / Math.max(1, total) >= 0.6 || !buckets.size) return null;
  const top = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  return [Math.round(top.r / top.n), Math.round(top.g / top.n), Math.round(top.b / top.n)];
}
const nearBg = (rgb: [number, number, number], bg: [number, number, number] | null) =>
  bg != null && Math.hypot(rgb[0] - bg[0], rgb[1] - bg[1], rgb[2] - bg[2]) < 45;

const PIPELINE_MODULES = ["pipeline", "smooth2", "smooth3", "regular", "emit", "g1", "orient", "deloop", "verify", "render_svg"];

type Pick = { rgb: [number, number, number]; hex: string; role: "layer" | "bg"; name: string; profile: Profile };
type Mode = "idle" | "custom";
type StageBg = "dark" | "light" | "black" | "checker";

interface Step {
  id: string;
  label: string;
  detail: string;
  status: "idle" | "running" | "completed" | "error";
}

const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

async function fileToB64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
async function urlToB64(url: string): Promise<string> { return fileToB64(await (await fetch(url)).blob()); }

async function loadPipelineSources(): Promise<Record<string, string>> {
  const src: Record<string, string> = {};
  await Promise.all(PIPELINE_MODULES.map(async (m) => {
    src[`${m}.py`] = await (await fetch(`/pipeline/${m}.py?t=${Date.now()}`, { cache: "no-store" })).text();
  }));
  return src;
}
export default function Page() {
  const [mode, setMode] = useState<Mode>("idle");
  const [img, setImg] = useState<{ url: string; w: number; h: number; isSvg: boolean } | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [results, setResults] = useState<LayerResult[]>([]);
  const [secs, setSecs] = useState("");
  const [poolSize, setPoolSize] = useState(0);
  const [arcWarning, setArcWarning] = useState(false);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [rawSvgContent, setRawSvgContent] = useState<string | null>(null);
  const [reportUrl, setReportUrl] = useState<string | null>(null);
  const [scale, setScale] = useState<number>(2);
  const [activeJobs, setActiveJobs] = useState<LayerJob[]>([]);
  const [activeViewBox, setActiveViewBox] = useState<string>("0 0 100 100");
  const [copied, setCopied] = useState(false);

  // Background Rect & Transparency Export Settings
  const [includeBg, setIncludeBg] = useState(false);
  const [bgHex, setBgHex] = useState("#FFFFFF");

  // Palette Sampler Eyedropper & Toast State
  const [hoverColor, setHoverColor] = useState<{ hex: string; rgb: [number, number, number]; x: number; y: number } | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [customHexInput, setCustomHexInput] = useState("#");

  // Color-reduction / quantized-preview feature
  const [kColorsCount, setKColorsCount] = useState(6);
  const [colorMergeThreshold, setColorMergeThreshold] = useState(32);
  const [showQuantizedPreview, setShowQuantizedPreview] = useState(false);
  const [layerCoverages, setLayerCoverages] = useState<Record<string, number>>({});
  const quantizedCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // SVG input: genuine vector paths passed through to the export (arc-safe scaled)
  const [svgVectors, setSvgVectors] = useState<VectorPath[]>([]);
  const [svgOrigin, setSvgOrigin] = useState<[number, number]>([0, 0]);
  const [svgNote, setSvgNote] = useState<string | null>(null);

  // Visual Stage Controls
  const [stageBg, setStageBg] = useState<StageBg>("dark");
  const [zoom, setZoom] = useState(1);

  // Vertical Stepper State
  const [steps, setSteps] = useState<Step[]>([
    { id: "boot", label: "Worker Environment", detail: "Initialize Pyodide Web Workers", status: "idle" },
    { id: "prepare", label: "Layer Preparation", detail: "Extract palette and build jobs", status: "idle" },
    { id: "compute", label: "Vector Computation", detail: "Parallel Python curve optimization", status: "idle" },
    { id: "assemble", label: "SVG Assembly", detail: "Combine paths into layered vector", status: "idle" }
  ]);

  // Slider State & Reveal Animation
  const [sliderPos, setSliderPos] = useState(0);
  const [isSliding, setIsSliding] = useState(false);
  const [isAnimatingReveal, setIsAnimatingReveal] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const sampleCanvas = useRef<HTMLCanvasElement | null>(null);
  const dispCanvas = useRef<HTMLCanvasElement | null>(null);

  const addLog = (s: string) => setLog((l) => [...l, s]);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2500);
  };

  const updateStepStatus = (id: string, status: Step["status"], detail?: string) => {
    setSteps(prev => prev.map(step => step.id === id ? { ...step, status, detail: detail || step.detail } : step));
  };

  const resetSteps = () => {
    setSteps([
      { id: "boot", label: "Worker Environment", detail: "Initialize Pyodide Web Workers", status: "idle" },
      { id: "prepare", label: "Layer Preparation", detail: "Extract palette and build jobs", status: "idle" },
      { id: "compute", label: "Vector Computation", detail: "Parallel Python curve optimization", status: "idle" },
      { id: "assemble", label: "SVG Assembly", detail: "Combine paths into layered vector", status: "idle" }
    ]);
  };

  const reset = () => {
    setResults([]);
    setSvgUrl(null);
    setRawSvgContent(null);
    setReportUrl(null);
    setLog([]);
    setActiveJobs([]);
    setCopied(false);
    setSliderPos(0);
    setIsAnimatingReveal(false);
    resetSteps();
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Sync sampleCanvas to dispCanvas whenever img or DOM ref changes
  const renderDispCanvas = useCallback(() => {
    const d = dispCanvas.current;
    const s = sampleCanvas.current;
    if (!d || !s) return;
    const ctx = d.getContext("2d");
    if (!ctx) return;

    const maxW = 340;
    const k = Math.min(1, maxW / s.width);
    d.width = Math.round(s.width * k);
    d.height = Math.round(s.height * k);

    ctx.clearRect(0, 0, d.width, d.height);
    ctx.drawImage(s, 0, 0, d.width, d.height);
  }, []);

  useEffect(() => {
    if (img && sampleCanvas.current) {
      renderDispCanvas();
    }
  }, [img, renderDispCanvas]);

  // Color quantization helper
  const extractDominantColors = useCallback((sCtx: CanvasRenderingContext2D, width: number, height: number): Pick[] => {
    const maxSamples = 10000;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
    const imgData = sCtx.getImageData(0, 0, width, height).data;
    const buckets = new Map<string, { r: number; g: number; b: number; count: number }>();

    for (let i = 0; i < imgData.length; i += 4 * step) {
      const a = imgData[i + 3];
      if (a < 100) continue;
      const r = imgData[i];
      const g = imgData[i + 1];
      const b = imgData[i + 2];

      const qr = Math.round(r / 24) * 24;
      const qg = Math.round(g / 24) * 24;
      const qb = Math.round(b / 24) * 24;
      const key = `${qr},${qg},${qb}`;

      const bckt = buckets.get(key);
      if (bckt) {
        bckt.count++;
        bckt.r += r; bckt.g += g; bckt.b += b;
      } else {
        buckets.set(key, { r, g, b, count: 1 });
      }
    }

    const sorted = Array.from(buckets.values()).sort((a, b) => b.count - a.count);
    const selected: { rgb: [number, number, number]; hex: string }[] = [];

    for (const c of sorted) {
      const avgR = Math.round(c.r / c.count);
      const avgG = Math.round(c.g / c.count);
      const avgB = Math.round(c.b / c.count);

      const isSimilar = selected.some(s => {
        const dr = s.rgb[0] - avgR;
        const dg = s.rgb[1] - avgG;
        const db = s.rgb[2] - avgB;
        return Math.sqrt(dr * dr + dg * dg + db * db) < 45;
      });

      if (!isSimilar) {
        selected.push({
          rgb: [avgR, avgG, avgB],
          hex: toHex(avgR, avgG, avgB)
        });
      }
      if (selected.length >= 6) break;
    }

    // Sort selected layers by perceived luminance: lightest colors (containers/backgrounds) first, darkest (text/outlines) last
    selected.sort((a, b) => {
      const lumA = 0.299 * a.rgb[0] + 0.587 * a.rgb[1] + 0.114 * a.rgb[2];
      const lumB = 0.299 * b.rgb[0] + 0.587 * b.rgb[1] + 0.114 * b.rgb[2];
      return lumB - lumA; // Descending: light first, dark last
    });

    return selected.map((s, i) => ({
      rgb: s.rgb,
      hex: s.hex,
      role: "layer",
      name: `color-${i + 1}`,
      profile: "organic"
    }));
  }, []);

  const extractQuantizedPalette = useCallback((targetK: number) => {
    if (!sampleCanvas.current || !img) return;
    const sCtx = sampleCanvas.current.getContext("2d");
    if (!sCtx) return;
    const w = img.w, h = img.h;
    const imgData = sCtx.getImageData(0, 0, w, h).data;
    const pixels: [number, number, number][] = [];

    for (let i = 0; i < imgData.length; i += 4 * 2) {
      if (imgData[i + 3] >= 100) {
        pixels.push([imgData[i], imgData[i + 1], imgData[i + 2]]);
      }
    }
    if (!pixels.length) return;

    // Deterministic K-Means++ Initialization (Furthest Point Sampling)
    const centroids: [number, number, number][] = [];
    centroids.push(pixels[Math.floor(pixels.length / 2)]); // Deterministic first seed

    while (centroids.length < targetK && centroids.length < pixels.length) {
      let maxD = -1;
      let nextC = pixels[0];
      for (let i = 0; i < pixels.length; i += 5) {
        const p = pixels[i];
        let minD = Infinity;
        for (const c of centroids) {
          const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
          if (d < minD) minD = d;
        }
        if (minD > maxD) {
          maxD = minD;
          nextC = p;
        }
      }
      centroids.push(nextC);
    }

    for (let iter = 0; iter < 6; iter++) {
      const clusters: [number, number, number][][] = Array.from({ length: centroids.length }, () => []);
      for (const p of pixels) {
        let minD = Infinity, bestIdx = 0;
        for (let cIdx = 0; cIdx < centroids.length; cIdx++) {
          const c = centroids[cIdx];
          const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
          if (d < minD) { minD = d; bestIdx = cIdx; }
        }
        clusters[bestIdx].push(p);
      }
      for (let cIdx = 0; cIdx < centroids.length; cIdx++) {
        if (clusters[cIdx].length > 0) {
          let sr = 0, sg = 0, sb = 0;
          for (const p of clusters[cIdx]) { sr += p[0]; sg += p[1]; sb += p[2]; }
          const len = clusters[cIdx].length;
          centroids[cIdx] = [Math.round(sr / len), Math.round(sg / len), Math.round(sb / len)];
        }
      }
    }

    centroids.sort((a, b) => {
      const lumA = 0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2];
      const lumB = 0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2];
      return lumB - lumA;
    });

    // Mark the border/background colour as BG (kept in palette for unmixing, not
    // computed as a slow full-canvas layer).
    const bg = detectBgRgb(imgData, w, h);
    const newPicks: Pick[] = centroids.map((c, i) => ({
      rgb: c,
      hex: toHex(c[0], c[1], c[2]),
      role: nearBg(c, bg) ? "bg" : "layer",
      name: nearBg(c, bg) ? "background" : `color-${i + 1}`,
      profile: "organic"
    }));

    setPicks(newPicks);
    showToast(`Quantized artwork into ${newPicks.length} layer colors`);
  }, [img]);

  const autoExtractPalette = useCallback(() => {
    extractQuantizedPalette(kColorsCount);
  }, [extractQuantizedPalette, kColorsCount]);

  const mergeSimilarPicks = useCallback(() => {
    if (picks.length < 2) return;
    const threshSq = colorMergeThreshold * colorMergeThreshold;
    const merged: Pick[] = [];
    const mergedFlags = new Array(picks.length).fill(false);

    for (let i = 0; i < picks.length; i++) {
      if (mergedFlags[i]) continue;
      const primary = { ...picks[i] };
      const [r1, g1, b1] = primary.rgb;
      let totalR = r1, totalG = g1, totalB = b1, count = 1;

      for (let j = i + 1; j < picks.length; j++) {
        if (mergedFlags[j]) continue;
        const target = picks[j];
        const [r2, g2, b2] = target.rgb;
        const distSq = (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
        if (distSq <= threshSq) {
          mergedFlags[j] = true;
          totalR += r2; totalG += g2; totalB += b2;
          count++;
        }
      }
      const avgR = Math.round(totalR / count);
      const avgG = Math.round(totalG / count);
      const avgB = Math.round(totalB / count);
      primary.rgb = [avgR, avgG, avgB];
      primary.hex = toHex(avgR, avgG, avgB);
      merged.push(primary);
    }

    if (merged.length < picks.length) {
      setPicks(merged);
      showToast(`Merged ${picks.length - merged.length} similar color layer(s)`);
    } else {
      showToast("No similar layers within merge threshold");
    }
  }, [picks, colorMergeThreshold]);

  const renderQuantizedPreview = useCallback(() => {
    const s = sampleCanvas.current;
    const qc = quantizedCanvasRef.current;
    if (!s || !qc || !picks.length) return;
    const sCtx = s.getContext("2d");
    if (!sCtx) return;
    qc.width = s.width;
    qc.height = s.height;
    const qCtx = qc.getContext("2d");
    if (!qCtx) return;

    const imgData = sCtx.getImageData(0, 0, s.width, s.height);
    const data = imgData.data;
    const outData = qCtx.createImageData(s.width, s.height);
    const out = outData.data;
    const palette = picks.map((p) => p.rgb);
    const counts: number[] = new Array(palette.length).fill(0);
    let totalNonTrans = 0;

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a < 50) {
        out[i + 3] = 0;
        continue;
      }
      totalNonTrans++;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let minDist = Infinity, bestIdx = 0;
      for (let j = 0; j < palette.length; j++) {
        const [pr, pg, pb] = palette[j];
        const dr = r - pr, dg = g - pg, db = b - pb;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) {
          minDist = dist;
          bestIdx = j;
        }
      }
      counts[bestIdx]++;
      const [bestR, bestG, bestB] = palette[bestIdx];
      out[i] = bestR; out[i + 1] = bestG; out[i + 2] = bestB; out[i + 3] = 255;
    }
    qCtx.putImageData(outData, 0, 0);

    if (totalNonTrans > 0) {
      const covs: Record<string, number> = {};
      picks.forEach((p, idx) => {
        covs[p.hex] = Math.round((counts[idx] / totalNonTrans) * 100);
      });
      setLayerCoverages(covs);
    }
  }, [picks]);

  useEffect(() => {
    if (img) {
      renderQuantizedPreview();
    }
  }, [showQuantizedPreview, img, renderQuantizedPreview]);

  // ---- image drop / palette picking -------------------------------------
  // Extract initial palette from a source context, marking the border colour BG.
  const extractWithBg = (sCtx: CanvasRenderingContext2D, w: number, h: number): Pick[] => {
    const extracted = extractDominantColors(sCtx, w, h);
    const bg = detectBgRgb(sCtx.getImageData(0, 0, w, h).data, w, h);
    return extracted.map((p) =>
      nearBg(p.rgb, bg) ? { ...p, role: "bg" as const, name: "background" } : p);
  };

  const onFile = useCallback(async (file: File) => {
    reset(); setPicks([]); setArcWarning(false); setSvgVectors([]); setSvgOrigin([0, 0]); setSvgNote(null);
    const isSvg = file.name.toLowerCase().endsWith(".svg");

    if (isSvg) {
      // Real Stage 0: DOMParser (not regex) + arc-safe passthrough. Handles
      // raster-in-wrapper + genuine vector paths + style inlining + <use> offsets.
      const text = await file.text();
      let parsed;
      try { parsed = parseSvgInput(text); }
      catch (e) { addLog("SVG parse failed: " + String(e)); setImg(null); setMode("idle"); return; }

      setSvgVectors(parsed.vectors);
      setSvgOrigin([parsed.viewBox[0], parsed.viewBox[1]]);
      const notes = [`${parsed.rasters.length} embedded raster(s), ${parsed.vectors.length} vector path(s) (passed through)`];
      if (parsed.fullCanvasRects.length) notes.push(`${parsed.fullCanvasRects.length} full-canvas rect(s) dropped`);
      if (parsed.unsupported.length) notes.push(`ignored: ${parsed.unsupported.join(", ")}`);
      setSvgNote(notes.join(" · ")); addLog("SVG: " + notes.join(" · "));

      if (parsed.rasters.length === 0) {
        // Pure vector: there are no worker jobs, so finalize passthrough here.
        const viewBox = `0 0 ${parsed.width * scale} ${parsed.height * scale}`;
        const passthrough = parsed.vectors.map((v, i) => ({
          id: `lettering-${i}`, fill: v.fill,
          d: scalePathData(v.d, scale, -parsed.viewBox[0], -parsed.viewBox[1]),
        }));
        const svg = assembleLayers(passthrough, viewBox, includeBg ? bgHex : null);
        setImg({ url: URL.createObjectURL(file), w: parsed.width, h: parsed.height, isSvg: true });
        setActiveViewBox(viewBox);
        setRawSvgContent(svg);
        setSvgUrl(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));
        setReportUrl(URL.createObjectURL(new Blob([JSON.stringify({
          viewBox, passthroughLayers: passthrough.length, unsupported: parsed.unsupported,
        }, null, 2)], { type: "application/json" })));
        setSecs("0.0");
        setPoolSize(0);
        addLog(`Pure-vector SVG ready: preserved ${passthrough.length} path(s)`);
        setMode("custom");
        return;
      }
      const canvas = await compositeRasters(parsed);
      sampleCanvas.current = canvas;
      setImg({ url: canvas.toDataURL(), w: canvas.width, h: canvas.height, isSvg: true });
      setMode("custom");
      const picks = extractWithBg(canvas.getContext("2d")!, canvas.width, canvas.height);
      if (picks.length) setPicks(picks);
      return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    await new Promise((r) => { image.onload = r; image.src = url; });
    const s = document.createElement("canvas");
    s.width = image.naturalWidth; s.height = image.naturalHeight;
    const sCtx = s.getContext("2d")!;
    sCtx.drawImage(image, 0, 0);
    sampleCanvas.current = s;
    setImg({ url, w: image.naturalWidth, h: image.naturalHeight, isSvg: false });
    setMode("custom");

    const extracted = extractWithBg(sCtx, image.naturalWidth, image.naturalHeight);
    if (extracted.length > 0) setPicks(extracted);
  }, [extractDominantColors, scale, includeBg, bgHex]);

  const onCanvasMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dispCanvas.current, s = sampleCanvas.current; if (!d || !s || !img) return;
    const rect = d.getBoundingClientRect();
    const x = Math.max(0, Math.min(Math.floor(((e.clientX - rect.left) / rect.width) * s.width), s.width - 1));
    const y = Math.max(0, Math.min(Math.floor(((e.clientY - rect.top) / rect.height) * s.height), s.height - 1));
    const p = s.getContext("2d")!.getImageData(x, y, 1, 1).data;
    const rgb: [number, number, number] = [p[0], p[1], p[2]];
    const hex = toHex(p[0], p[1], p[2]);
    setHoverColor({ hex, rgb, x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, [img]);

  const onCanvasMouseLeave = useCallback(() => setHoverColor(null), []);

  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const d = dispCanvas.current, s = sampleCanvas.current; if (!d || !s || !img) return;
    const rect = d.getBoundingClientRect();
    const x = Math.max(0, Math.min(Math.floor(((e.clientX - rect.left) / rect.width) * s.width), s.width - 1));
    const y = Math.max(0, Math.min(Math.floor(((e.clientY - rect.top) / rect.height) * s.height), s.height - 1));
    const p = s.getContext("2d")!.getImageData(x, y, 1, 1).data;
    const rgb: [number, number, number] = [p[0], p[1], p[2]];
    const hex = toHex(p[0], p[1], p[2]);

    setPicks((prev) => {
      if (prev.some((q) => q.hex === hex)) {
        showToast(`Color ${hex} already in layers`);
        return prev;
      }
      showToast(`+ Added ${hex} as layer-${prev.length + 1}`);
      return [...prev, { rgb, hex, role: "layer", name: `layer-${prev.length + 1}`, profile: "organic" }];
    });
  }, [img]);

  const addCustomHexColor = () => {
    let hex = customHexInput.trim();
    if (!hex.startsWith("#")) hex = "#" + hex;
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      showToast("Invalid hex code (e.g. #FF0000)");
      return;
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const rgb: [number, number, number] = [r, g, b];

    setPicks((prev) => {
      if (prev.some((q) => q.hex.toLowerCase() === hex.toLowerCase())) {
        showToast(`Color ${hex} already in layers`);
        return prev;
      }
      showToast(`+ Added custom ${hex}`);
      return [...prev, { rgb, hex, role: "layer", name: `color-${prev.length + 1}`, profile: "organic" }];
    });
    setCustomHexInput("#");
  };


  const updatePick = (i: number, patch: Partial<Pick>) => setPicks((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const removePick = (i: number) => setPicks((prev) => prev.filter((_, j) => j !== i));
  const movePick = (i: number, dir: -1 | 1) => setPicks((prev) => {
    const j = i + dir; if (j < 0 || j >= prev.length) return prev;
    const c = [...prev];[c[i], c[j]] = [c[j], c[i]]; return c;
  });

  const autoSortPicksByLuminance = () => {
    setPicks((prev) => {
      const sorted = [...prev].sort((a, b) => {
        const lumA = 0.299 * a.rgb[0] + 0.587 * a.rgb[1] + 0.114 * a.rgb[2];
        const lumB = 0.299 * b.rgb[0] + 0.587 * b.rgb[1] + 0.114 * b.rgb[2];
        return lumB - lumA;
      });
      showToast("Z-Index auto-sorted: Light (back) → Dark (front)");
      return sorted;
    });
  };

  // ---- run --------------------------------------------------------------
  const execute = useCallback(async (jobs: LayerJob[], pngs: Record<string, string>, viewBox: string) => {
    setRunning(true); reset(); setActiveJobs(jobs); setActiveViewBox(viewBox); setSliderPos(0); setIsAnimatingReveal(false);
    const size = choosePoolSize(jobs.length);
    setPoolSize(size);

    updateStepStatus("boot", "running", `Booting ${size} Pyodide web worker(s)...`);

    const sources = await loadPipelineSources();
    const pool = new ComputePool(sources, pngs, {
      onProgress: (msg) => {
        addLog(msg);
        if (msg.includes("Worker") && msg.includes("ready")) {
          updateStepStatus("boot", "running", msg);
        }
      },
      onLayer: (r) => {
        setResults((rs) => [...rs, r]);
        updateStepStatus("compute", "running", `Computed layer ${r.name} (${r.nodes} nodes)`);
      }
    });

    const t0 = performance.now();
    try {
      await pool.boot(size);
      updateStepStatus("boot", "completed", `${size} Workers active`);

      updateStepStatus("prepare", "completed", `${jobs.length} jobs assigned`);
      updateStepStatus("compute", "running", `Processing ${jobs.length} vector layer(s)...`);

      const res = await pool.run(jobs);
      updateStepStatus("compute", "completed", `All ${res.length} layers vectorised`);

      updateStepStatus("assemble", "running", "Assembling final SVG document...");
      const wall = ((performance.now() - t0) / 1000).toFixed(1);
      setSecs(wall); setResults(res);

      const ordered: AssembledLayer[] = jobs
        .map((j) => {
          const r = res.find((x) => x.name === j.name);
          return r ? { id: j.id, fill: j.fill, d: r.d ?? "" } : null;
        })
        .filter((x): x is AssembledLayer => x !== null);
      const passthrough: AssembledLayer[] = svgVectors.map((v, i) => ({
        id: `lettering-${i}`, fill: v.fill,
        d: scalePathData(v.d, scale, -svgOrigin[0], -svgOrigin[1]),
      }));
      const svg = assembleLayers([...ordered, ...passthrough], viewBox, includeBg ? bgHex : null);
      setRawSvgContent(svg);
      setSvgUrl(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));

      const report = {
        poolSize: size, wallSeconds: +wall, viewBox,
        layers: res.map((r) => ({
          name: r.name, nodes: r.nodes, iou: r.iou, mean: r.mean,
          byteIdentical: r.identical, cleanup: r.cleanup,
        })),
      };
      setReportUrl(URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" })));

      updateStepStatus("assemble", "completed", `SVG ready (${wall}s wall time)`);
      addLog(`Execution completed: ${res.length} layers in ${wall}s across ${size} workers`);

      // Trigger full-screen reveal sweep animation: 0% -> 100% -> 0% -> 50%
      setIsAnimatingReveal(true);
      setSliderPos(100);
      setTimeout(() => {
        setSliderPos(0);
        setTimeout(() => {
          setSliderPos(50);
          setTimeout(() => {
            setIsAnimatingReveal(false);
          }, 700);
        }, 800);
      }, 150);
    } catch (err) {
      updateStepStatus("compute", "error", "Pipeline execution failed");
      updateStepStatus("assemble", "error", String(err));
      addLog("ERROR: " + String(err));
    } finally {
      pool.terminate(); setRunning(false);
    }
  }, [includeBg, bgHex, svgVectors, svgOrigin, scale]);

  useEffect(() => {
    if (activeJobs.length > 0 && results.length === activeJobs.length) {
      const ordered: AssembledLayer[] = activeJobs
        .map((j) => {
          const r = results.find((x) => x.name === j.name);
          return r ? { id: j.id, fill: j.fill, d: r.d ?? "" } : null;
        })
        .filter((x): x is AssembledLayer => x !== null);
      const passthrough: AssembledLayer[] = svgVectors.map((v, i) => ({
        id: `lettering-${i}`, fill: v.fill,
        d: scalePathData(v.d, scale, -svgOrigin[0], -svgOrigin[1]),
      }));
      const svg = assembleLayers([...ordered, ...passthrough], activeViewBox, includeBg ? bgHex : null);
      setRawSvgContent(svg);
      setSvgUrl(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));
    }
  }, [includeBg, bgHex, results, activeJobs, activeViewBox, svgVectors, svgOrigin, scale]);

  useEffect(() => {
    if (activeJobs.length === 0 && svgVectors.length > 0 && img?.isSvg) {
      const viewBox = `0 0 ${img.w * scale} ${img.h * scale}`;
      const passthrough = svgVectors.map((v, i) => ({
        id: `lettering-${i}`, fill: v.fill,
        d: scalePathData(v.d, scale, -svgOrigin[0], -svgOrigin[1]),
      }));
      const svg = assembleLayers(passthrough, viewBox, includeBg ? bgHex : null);
      setActiveViewBox(viewBox);
      setRawSvgContent(svg);
      setSvgUrl(URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })));
    }
  }, [activeJobs.length, svgVectors, svgOrigin, img, scale, includeBg, bgHex]);

  const runCustom = useCallback(async () => {
    if (!img) return;
    const palette = picks.map((p) => p.rgb);
    const layerPicks = picks.map((p, i) => ({ p, i })).filter(({ p }) => p.role === "layer");
    if (!layerPicks.length) { addLog("Pick at least one colour and mark it as a Layer"); return; }
    const pngB64 = await urlToB64(img.url);
    const capVal = Math.max(0.25, 2.0 / Math.max(1, scale / 2));
    const tolVal = Math.max(0.2, 1.0 / Math.max(1, scale / 2));
    const jobs: LayerJob[] = layerPicks.map(({ p, i }, k) => ({
      jobId: k, name: `user-${i}`, engine: p.profile === "geometric" ? "smooth3" : "smooth2",
      useG1: p.profile === "geometric", file: "user.png", offset: [0, 0], palette, idx: i,
      cfg: p.profile === "geometric" ? [capVal, tolVal, true, 25.0, 25.0] : null, scale, expected: null,
      fill: p.hex, id: p.name,
    }));
    await execute(jobs, { "user.png": pngB64 }, `0 0 ${img.w * scale} ${img.h * scale}`);
  }, [img, picks, scale, execute]);

  const onStageImageClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const s = sampleCanvas.current; if (!s || !img) return;
    const imgEl = e.currentTarget;
    const rect = imgEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(Math.floor(((e.clientX - rect.left) / rect.width) * s.width), s.width - 1));
    const y = Math.max(0, Math.min(Math.floor(((e.clientY - rect.top) / rect.height) * s.height), s.height - 1));
    const p = s.getContext("2d")!.getImageData(x, y, 1, 1).data;
    const rgb: [number, number, number] = [p[0], p[1], p[2]];
    const hex = toHex(p[0], p[1], p[2]);

    setPicks((prev) => {
      if (prev.some((q) => q.hex === hex)) {
        showToast(`Color ${hex} already in layers`);
        return prev;
      }
      showToast(`+ Added ${hex} from stage as layer-${prev.length + 1}`);
      return [...prev, { rgb, hex, role: "layer", name: `layer-${prev.length + 1}`, profile: "organic" }];
    });
  }, [img]);

  const copySvgToClipboard = () => {
    if (!rawSvgContent) return;
    navigator.clipboard.writeText(rawSvgContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const canRunCustom = mode === "custom" && picks.some((p) => p.role === "layer") && !running;
  const isGeometric = picks.some(p => p.profile === 'geometric');

  // Slider Mouse/Touch Handlers
  const handleMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isSliding || !sliderRef.current) return;
    const rect = sliderRef.current.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
    setSliderPos((x / rect.width) * 100);
  }, [isSliding]);

  useEffect(() => {
    if (isSliding) {
      window.addEventListener("mousemove", handleMove);
      window.addEventListener("touchmove", handleMove);
      window.addEventListener("mouseup", () => setIsSliding(false));
      window.addEventListener("touchend", () => setIsSliding(false));
    }
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("touchmove", handleMove);
    };
  }, [isSliding, handleMove]);

  // Canonical SVG stage renderer (100% parity with exported file)
  const renderProgressiveSvg = () => {
    if (!activeJobs.length) return null;
    const isComplete = results.length === activeJobs.length && activeJobs.length > 0;
    if (isComplete && rawSvgContent) {
      return (
        <div
          className="w-full h-full flex items-center justify-center [&>svg]:max-w-full [&>svg]:max-h-full [&>svg]:w-auto [&>svg]:h-auto [&>svg]:object-contain drop-shadow-2xl transition-all duration-700"
          dangerouslySetInnerHTML={{ __html: rawSvgContent }}
        />
      );
    }
    const vbParts = activeViewBox.split(" ");
    const vbW = vbParts[2] ?? "100";
    const vbH = vbParts[3] ?? "100";
    return (
      <svg viewBox={activeViewBox} xmlns="http://www.w3.org/2000/svg" className="w-full h-full object-contain drop-shadow-2xl transition-all duration-700">
        {includeBg && <rect width={vbW} height={vbH} fill={bgHex} />}
        {activeJobs.map(job => {
          const res = results.find(r => r.name === job.name);
          return res && res.d ? <path key={job.name} fill={job.fill} fillRule="evenodd" d={res.d} style={{ transition: 'opacity 0.5s ease-in', opacity: 1 }} /> : null;
        })}
      </svg>
    );
  };

  return (
    <div className="flex h-screen w-full overflow-hidden text-[var(--text)] select-none bg-[var(--bg)] font-sans">

      {/* ---------------- LEFT PANE: Control Panel (38% / min 440px max 560px) ---------------- */}
      <div className="w-[38%] min-w-[440px] max-w-[560px] flex flex-col border-r border-[var(--panel-border)] bg-[var(--panel)] backdrop-blur-xl z-20 shadow-2xl overflow-y-auto">

        {/* Header Branding */}
        <header className="p-4 pb-3 border-b border-white/5 flex items-center justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-[#d4af37] via-[#fef08a] to-[#d4af37]">
                Vectorizer
              </h1>
              <span className="text-[10px] uppercase font-mono tracking-widest px-2 py-0.5 rounded-full bg-[var(--accent-glow)] border border-[var(--accent)]/40 text-[var(--accent)]">
                v1.0
              </span>
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--muted)] leading-tight">
              In-Browser Pyodide Pool. Quality beats speed.
            </p>
          </div>
          {running && (
            <div className="flex items-center gap-1.5 bg-[var(--accent)]/10 border border-[var(--accent)]/30 text-[var(--accent)] px-2.5 py-1 rounded-full text-xs font-mono animate-pulse">
              <span className="w-2 h-2 rounded-full bg-[var(--accent)]"></span>
              Compute
            </div>
          )}
        </header>

        <div className="flex-1 p-4 space-y-3.5">

          {/* Upload Dropzone */}
          <section className="space-y-1.5">
            <div className="flex justify-between items-center text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              <span>Source Artwork</span>
              <span className="text-[10px] text-white/40 font-normal">PNG, WEBP, SVG</span>
            </div>
            <div
              className="group relative rounded-xl border-2 border-dashed border-[var(--panel-border)] hover:border-[var(--accent)] bg-black/30 hover:bg-black/50 p-3 text-center transition-all cursor-pointer shadow-inner flex items-center justify-center gap-3"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
              onClick={() => document.getElementById("file-upload")?.click()}
            >
              <input id="file-upload" type="file" accept=".png,.jpg,.jpeg,.webp,.svg" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
              <div className="w-8 h-8 rounded-full bg-white/5 group-hover:bg-[var(--accent)]/10 flex items-center justify-center shrink-0 text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <div className="text-left">
                <p className="text-xs font-semibold text-[var(--text)] group-hover:text-[var(--accent)] transition-colors">Drop raster artwork here</p>
                <p className="text-[10px] text-[var(--muted)]">or click to browse files</p>
              </div>
            </div>

            <div className="flex items-center justify-end pt-0.5">
              {img && (
                <button onClick={() => { setImg(null); setMode("idle"); reset(); }} className="text-[11px] text-[var(--muted)] hover:text-[var(--bad)] transition-colors">
                  Clear
                </button>
              )}
            </div>

            {svgNote && (
              <div className="rounded-lg border border-[var(--panel-border)] bg-white/5 p-2 text-xs text-[var(--muted)] backdrop-blur flex items-center gap-1.5">
                <svg className="w-4 h-4 shrink-0 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
                </svg>
                <span><b>SVG parsed</b> (arc-safe): {svgNote}</span>
              </div>
            )}
          </section>

          {/* Palette Inspector Canvas & Sampler */}
          {img && (
            <section className="space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-300">
              {/* Color Reduction (K-Means Posterization) Box */}
              <div className="rounded-xl bg-black/40 border border-[var(--panel-border)] p-3 space-y-2.5 shadow-inner">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </svg>
                    <span className="text-[11px] text-[var(--muted)] uppercase tracking-wider font-semibold">Color Reduction (K-Means)</span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-[var(--accent-glow)] border border-[var(--accent)]/40 text-[var(--accent)] text-[10px] font-mono font-bold">
                    {kColorsCount} Colors
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-white/80 font-medium">Posterization Layers (K)</span>
                    <span className="font-mono text-[var(--accent)] font-bold">{kColorsCount} Layers</span>
                  </div>
                  <input
                    type="range"
                    min="2"
                    max="12"
                    step="1"
                    value={kColorsCount}
                    onChange={(e) => {
                      const k = Number(e.target.value);
                      setKColorsCount(k);
                      extractQuantizedPalette(k);
                    }}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[var(--accent)] hover:bg-white/20 transition-all"
                  />
                  <div className="grid grid-cols-4 gap-1 pt-0.5">
                    {[2, 4, 6, 8].map((kVal) => (
                      <button
                        key={kVal}
                        type="button"
                        onClick={() => {
                          setKColorsCount(kVal);
                          extractQuantizedPalette(kVal);
                        }}
                        className={`py-1 px-1 rounded-lg text-[10px] font-mono font-semibold transition-all ${kColorsCount === kVal
                          ? "bg-[var(--accent)] text-black shadow-[0_0_12px_rgba(212,175,55,0.4)] scale-[1.02]"
                          : "bg-white/5 hover:bg-white/10 text-white/70"
                          }`}
                      >
                        {kVal} Colors
                      </button>
                    ))}
                  </div>
                </div>

                {/* Color Merge Sensitivity Slider & Action */}
                <div className="space-y-1.5 pt-1.5 border-t border-white/10">
                  <div className="flex justify-between items-center text-[10px]">
                    <span className="text-white/80 font-medium">Color Merge Sensitivity</span>
                    <span className="font-mono text-[var(--accent)] font-bold">{colorMergeThreshold} Dist</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="5"
                      max="70"
                      step="5"
                      value={colorMergeThreshold}
                      onChange={(e) => setColorMergeThreshold(Number(e.target.value))}
                      className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[var(--accent)] hover:bg-white/20 transition-all"
                    />
                    <button
                      type="button"
                      onClick={mergeSimilarPicks}
                      className="px-2.5 py-1 rounded bg-[var(--accent)] hover:brightness-110 text-black text-[10px] font-bold shadow flex items-center gap-1 transition-all shrink-0"
                      title="Merge color layers with similar RGB shades into a single solid layer"
                    >
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" />
                      </svg>
                      <span>Merge Similar</span>
                    </button>
                  </div>
                  <p className="text-[9px] text-white/40 leading-tight">
                    Merges multi-shade anti-aliasing transitions (e.g. 3 green shades) into one uniform solid layer.
                  </p>
                </div>
              </div>

              <div className="rounded-xl bg-black/40 border border-[var(--panel-border)] p-2.5 space-y-2">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="text-[11px] text-[var(--muted)] uppercase tracking-wider font-semibold">Palette Sampler</p>
                    <p className="text-[10px] text-white/40">{img.w} × {img.h} px</p>
                  </div>
                  <button
                    onClick={autoExtractPalette}
                    className="text-[10px] bg-white/10 hover:bg-[var(--accent)] hover:text-black font-semibold text-white px-2 py-1 rounded transition-colors flex items-center gap-1"
                    title="Re-run K-Means color quantization"
                  >
                    <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
                    </svg>
                    <span>Auto Quantize</span>
                  </button>
                </div>

                {/* Canvas Container with Hover Eyedropper Loupe */}
                <div className="relative rounded-lg overflow-hidden border border-white/10 group cursor-crosshair bg-black/60 shadow-inner max-h-32 flex items-center justify-center">
                  <canvas
                    ref={dispCanvas}
                    onClick={onCanvasClick}
                    onMouseMove={onCanvasMouseMove}
                    onMouseLeave={onCanvasMouseLeave}
                    className="max-h-32 w-auto block object-contain"
                  />

                  {/* Eyedropper Hover Loupe Overlay */}
                  {hoverColor && (
                    <div
                      className="pointer-events-none absolute z-30 transform -translate-x-1/2 -translate-y-12 bg-black/90 border border-white/20 p-1 rounded-xl shadow-2xl flex items-center gap-1.5 backdrop-blur-md"
                      style={{ left: hoverColor.x, top: hoverColor.y }}
                    >
                      <span className="w-3.5 h-3.5 rounded-full border border-white/40 shadow-inner" style={{ background: hoverColor.hex }} />
                      <span className="font-mono text-[10px] text-white font-bold">{hoverColor.hex}</span>
                    </div>
                  )}

                  {!hoverColor && (
                    <div className="absolute inset-0 pointer-events-none bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-1.5">
                      <span className="text-[9px] text-white/80 font-mono">Click pixel to add color layer</span>
                    </div>
                  )}
                </div>

                {/* Quick Add Custom Hex Color Input */}
                <div className="flex gap-1.5 pt-0.5">
                  <input
                    type="text"
                    value={customHexInput}
                    onChange={(e) => setCustomHexInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") addCustomHexColor(); }}
                    placeholder="#FF0000"
                    className="flex-1 rounded-lg bg-white/5 border border-white/10 px-2 py-0.5 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-[var(--accent)]"
                  />
                  <button
                    onClick={addCustomHexColor}
                    className="px-2 py-0.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white transition-colors"
                  >
                    + Add Hex
                  </button>
                </div>

                {/* Floating Toast Notification */}
                {toastMsg && (
                  <div className="rounded-lg bg-[var(--accent)] text-black px-2.5 py-1 text-xs font-bold shadow-lg animate-in fade-in slide-in-from-top-1 text-center">
                    {toastMsg}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Layers List & Configuration */}
          {(mode === "custom" || picks.length > 0) && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-[11px] text-[var(--muted)] uppercase tracking-wider font-semibold flex items-center gap-1.5">
                  <span>Layers</span>
                  <span className="px-1.5 py-0.5 rounded-full bg-white/10 text-[10px] text-white font-mono">{picks.length}</span>
                </h2>
                {picks.length > 1 && (
                  <button
                    onClick={autoSortPicksByLuminance}
                    className="text-[10px] text-[var(--accent)] hover:underline flex items-center gap-1 font-medium"
                    title="Auto-order: light background containers first, dark detail/text layers on top"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16" />
                    </svg>
                    <span>Auto Z-Index</span>
                  </button>
                )}
              </div>

              <ul className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
                {picks.map((p, i) => (
                  <li key={p.hex + i} className="flex items-center gap-1.5 text-xs bg-black/40 p-1.5 rounded-lg border border-[var(--panel-border)] hover:border-white/20 transition-all group">
                    <label className="relative shrink-0 cursor-pointer group/swatch" title="Click to pick custom layer color">
                      <span className="h-4 w-4 rounded-md shadow-md border border-white/20 block transition-transform group-hover/swatch:scale-110" style={{ background: p.hex }} />
                      <input
                        type="color"
                        value={p.hex}
                        onChange={(e) => {
                          const hex = e.target.value;
                          const r = parseInt(hex.slice(1, 3), 16);
                          const g = parseInt(hex.slice(3, 5), 16);
                          const b = parseInt(hex.slice(5, 7), 16);
                          updatePick(i, { hex, rgb: [r, g, b] });
                        }}
                        className="opacity-0 absolute inset-0 w-full h-full cursor-pointer"
                      />
                    </label>
                    <input
                      value={p.name}
                      onChange={(e) => updatePick(i, { name: e.target.value })}
                      className="w-16 rounded bg-white/5 border border-transparent px-1 py-0.5 focus:outline-none focus:border-[var(--accent)] text-[var(--text)] font-medium text-xs transition-colors"
                    />
                    {layerCoverages[p.hex] !== undefined && (
                      <span className="font-mono text-[9px] px-1 py-0.5 rounded bg-white/10 text-[var(--accent)] font-bold shrink-0" title="Image area coverage percentage">
                        {layerCoverages[p.hex]}%
                      </span>
                    )}
                    <select
                      value={p.role}
                      onChange={(e) => updatePick(i, { role: e.target.value as Pick["role"] })}
                      className="rounded bg-[#16171b] border border-[var(--panel-border)] px-1 py-0.5 text-[10px] text-[var(--muted)] focus:outline-none focus:text-white"
                    >
                      <option value="layer">Layer</option>
                      <option value="bg">BG</option>
                    </select>

                    {p.role === "layer" && (
                      <select
                        value={p.profile}
                        onChange={(e) => updatePick(i, { profile: e.target.value as Profile })}
                        className="rounded bg-[#16171b] border border-[var(--panel-border)] px-1 py-0.5 text-[10px] text-[var(--muted)] focus:outline-none focus:text-white"
                      >
                        <option value="organic">Organic</option>
                        <option value="geometric">Geometric</option>
                      </select>
                    )}

                    <div className="ml-auto flex items-center gap-0.5">
                      <button
                        onClick={() => movePick(i, -1)}
                        disabled={i === 0}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-20 text-[var(--muted)] hover:text-white transition-colors"
                        title="Move layer up"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="18 15 12 9 6 15" />
                        </svg>
                      </button>
                      <button
                        onClick={() => movePick(i, 1)}
                        disabled={i === picks.length - 1}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-20 text-[var(--muted)] hover:text-white transition-colors"
                        title="Move layer down"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      <button
                        onClick={() => removePick(i)}
                        className="p-1 rounded hover:bg-[var(--bad)]/20 text-[var(--muted)] hover:text-[var(--bad)] transition-colors"
                        title="Remove layer"
                      >
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="18" y1="6" x2="6" y2="18" />
                          <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              {/* Geometric Regularization Warning Banner */}
              <div className={`transition-all duration-300 overflow-hidden ${isGeometric ? 'opacity-100 max-h-20' : 'opacity-0 max-h-0'}`}>
                <div className="rounded-lg border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-[11px] text-[var(--warn)] backdrop-blur-md flex items-start gap-1.5 shadow-lg">
                  <svg className="w-4 h-4 shrink-0 mt-0.5 text-[var(--warn)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <p className="leading-tight">
                    <b>Geometric active</b>: Facets curves into sharp polygons.
                  </p>
                </div>
              </div>

              {/* Vector Quality & Resolution Slider */}
              <div className="rounded-xl bg-black/40 border border-[var(--panel-border)] p-3 space-y-2.5 shadow-inner">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5 text-[var(--accent)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                    </svg>
                    <span className="text-[11px] text-[var(--muted)] uppercase tracking-wider font-semibold">Vector Quality</span>
                  </div>
                  <span className="px-2 py-0.5 rounded-full bg-[var(--accent-glow)] border border-[var(--accent)]/40 text-[var(--accent)] text-[10px] font-mono font-bold">
                    {scale}x {scale === 1 ? "(Fast)" : scale === 2 ? "(Standard)" : scale === 3 ? "(High)" : "(Ultra HD)"}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <input
                    type="range"
                    min="1"
                    max="4"
                    step="1"
                    value={scale}
                    onChange={(e) => setScale(Number(e.target.value))}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[var(--accent)] hover:bg-white/20 transition-all"
                  />
                  <div className="flex justify-between items-center text-[9px] font-mono text-[var(--muted)]">
                    <span>1x Fast</span>
                    <span>2x Standard</span>
                    <span>3x High</span>
                    <span>4x Ultra</span>
                  </div>
                </div>

                {/* Quick Quality Presets */}
                <div className="grid grid-cols-4 gap-1 pt-0.5">
                  {[1, 2, 3, 4].map((qVal) => (
                    <button
                      key={qVal}
                      type="button"
                      onClick={() => setScale(qVal)}
                      className={`py-1 px-1 rounded-lg text-[10px] font-mono font-semibold transition-all ${scale === qVal
                        ? "bg-[var(--accent)] text-black shadow-[0_0_12px_rgba(212,175,55,0.4)] scale-[1.02]"
                        : "bg-white/5 hover:bg-white/10 text-white/70"
                        }`}
                    >
                      {qVal}x
                    </button>
                  ))}
                </div>

                <p className="text-[10px] text-white/40 leading-tight">
                  Higher quality increases subpixel edge precision and viewBox coordinate resolution ({img ? `${img.w * scale}×${img.h * scale}px` : `${scale}x viewBox`}).
                </p>
              </div>

              {mode === "custom" && (
                <button
                  onClick={runCustom}
                  disabled={!canRunCustom}
                  className="w-full relative overflow-hidden rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#fef08a] px-3 py-2 text-xs font-bold text-black shadow-[0_0_20px_rgba(212,175,55,0.3)] hover:shadow-[0_0_30px_rgba(212,175,55,0.5)] active:scale-[0.99] transition-all disabled:opacity-30 disabled:shadow-none"
                >
                  {running ? "Processing Layers..." : "Vectorize Image"}
                </button>
              )}
            </section>
          )}

          {/* Inline Grid Stepper & Console Log */}
          <section className="space-y-2 pt-2 border-t border-[var(--panel-border)]">
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] text-[var(--muted)] uppercase tracking-wider font-semibold">
                Pipeline Status {poolSize > 0 && `(${poolSize} workers)`}
              </h2>
            </div>

            {/* Compact 2x2 Grid Stepper */}
            <div className="grid grid-cols-2 gap-1.5">
              {steps.map((step) => {
                const isCurrent = step.status === "running";
                const isDone = step.status === "completed";
                const isErr = step.status === "error";
                return (
                  <div key={step.id} className="flex items-center gap-1.5 p-1.5 rounded-lg bg-black/40 border border-white/5">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isDone ? 'bg-[var(--success)]' :
                      isCurrent ? 'bg-[var(--accent)] animate-pulse' :
                        isErr ? 'bg-[var(--bad)]' :
                          'bg-white/20'
                      }`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-[10px] font-semibold truncate leading-none ${isCurrent ? 'text-[var(--accent)]' : isDone ? 'text-white' : 'text-[var(--muted)]'}`}>
                        {step.label}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Compact Stdout Console */}
            <div className="bg-black/80 rounded-lg border border-white/10 p-2 font-mono text-[9px] text-emerald-400/90 h-20 overflow-y-auto space-y-0.5 shadow-inner">
              {log.length === 0 ? (
                <div className="text-white/20 italic">Ready for job dispatch...</div>
              ) : (
                log.map((l, i) => (
                  <div key={i} className="leading-tight opacity-90 break-words">
                    <span className="text-white/30 select-none mr-1.5">&gt;</span>
                    {l}
                  </div>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </section>

          {/* Export & Action Panel */}
          {rawSvgContent && !running && (
            <section className="space-y-2 pt-2 border-t border-[var(--panel-border)] animate-in fade-in duration-300">
              <div className="flex items-center justify-between text-[10px] text-[var(--muted)] font-mono">
                <span>Wall Time: <b className="text-[var(--accent)]">{secs}s</b></span>
                <span>Layers: <b className="text-white">{results.length || svgVectors.length}</b></span>
                <span>Workers: <b className="text-white">{poolSize}</b></span>
              </div>

              {/* Background Rect & Transparency Export Option */}
              <div className="rounded-lg bg-black/40 border border-white/10 p-2 space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-[var(--muted)] font-medium">
                    <input
                      type="checkbox"
                      checked={includeBg}
                      onChange={(e) => setIncludeBg(e.target.checked)}
                      className="rounded bg-white/10 border-white/20 text-[var(--accent)] focus:ring-0 cursor-pointer"
                    />
                    <span>Solid Background Rect</span>
                  </label>
                  {includeBg && (
                    <div className="flex items-center gap-1">
                      <span className="w-3.5 h-3.5 rounded border border-white/30" style={{ background: bgHex }} />
                      <input
                        type="text"
                        value={bgHex}
                        onChange={(e) => setBgHex(e.target.value)}
                        className="w-14 rounded bg-white/5 border border-white/10 px-1 py-0.5 text-[10px] font-mono text-white text-center focus:outline-none focus:border-[var(--accent)]"
                      />
                    </div>
                  )}
                </div>
                <p className="text-[9px] text-white/40 leading-tight">
                  {includeBg
                    ? "Export includes solid background rectangle to fill transparent cutout holes."
                    : "Export preserves transparent SVG background. Use checkerboard stage view to inspect."}
                </p>
              </div>

              <div className="flex gap-1.5">
                {svgUrl && (
                  <a
                    href={svgUrl}
                    download="vectorized.svg"
                    className="flex-1 text-center rounded-lg bg-gradient-to-r from-white to-gray-200 text-black px-3 py-1.5 text-xs font-bold hover:brightness-110 transition-all shadow flex items-center justify-center gap-1"
                  >
                    <span>Download SVG</span>
                  </a>
                )}

                <button
                  onClick={copySvgToClipboard}
                  className="rounded-lg border border-[var(--panel-border)] bg-white/5 px-2.5 py-1.5 text-xs font-medium text-[var(--text)] hover:bg-white/10 transition-colors flex items-center gap-1.5"
                >
                  {copied ? (
                    <>
                      <svg className="w-3.5 h-3.5 text-[var(--success)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-3.5 h-3.5 text-[var(--muted)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                      <span>Copy Code</span>
                    </>
                  )}
                </button>

                {reportUrl && (
                  <a
                    href={reportUrl}
                    download="report.json"
                    className="rounded-lg border border-[var(--panel-border)] bg-white/5 px-2.5 py-1.5 text-xs font-medium text-[var(--muted)] hover:text-white hover:bg-white/10 transition-colors"
                  >
                    JSON
                  </a>
                )}
              </div>
            </section>
          )}

        </div>
      </div>

      {/* ---------------- RIGHT PANE: Visual Stage (70%) ---------------- */}
      <div
        className={`flex-1 relative overflow-hidden flex flex-col items-center justify-center transition-colors duration-500 ${stageBg === "dark" ? "bg-grid-dark" :
          stageBg === "light" ? "bg-grid-light text-slate-900" :
            stageBg === "checker" ? "bg-checkerboard" :
              "bg-grid-black"
          }`}
        ref={sliderRef}
        onMouseDown={() => {
          if (!running && results.length > 0) {
            setIsAnimatingReveal(false);
            setIsSliding(true);
          }
        }}
      >

        {/* Stage Toolbar (Top Floating Overlay) */}
        <div className="absolute top-6 left-6 right-6 z-30 flex items-center justify-between pointer-events-none">
          {/* Mode Badge */}
          <div className="pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 px-3.5 py-1.5 rounded-full text-xs flex items-center gap-2 text-white/80 shadow-xl">
            <span className="w-2 h-2 rounded-full bg-[var(--accent)]"></span>
            <span className="font-semibold uppercase tracking-wider text-[10px]">
              {showQuantizedPreview ? "Color Reduction Pre-step" : results.length > 0 ? "Compare Stage" : "Visual Workspace"}
            </span>
          </div>

          {/* Color Reduction Pre-step Toggle Button */}
          {img && (
            <button
              onClick={() => {
                const next = !showQuantizedPreview;
                setShowQuantizedPreview(next);
                if (next) setTimeout(renderQuantizedPreview, 50);
              }}
              className={`pointer-events-auto text-[10px] font-semibold uppercase tracking-wider px-3.5 py-1.5 rounded-full backdrop-blur-md border transition-all flex items-center gap-1.5 shadow-xl ${showQuantizedPreview
                ? "bg-[var(--accent)] text-black border-[var(--accent)] shadow-[0_0_18px_rgba(212,175,55,0.5)] font-bold"
                : "bg-black/60 text-white/90 border-white/10 hover:border-white/30"
                }`}
              title="Toggle Pre-step view: displays artwork mapped to selected color layers before vectorizing"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
              </svg>
              <span>{showQuantizedPreview ? "Exit Color Reduction View" : "Color Reduction Pre-step"}</span>
            </button>
          )}

          {/* Zoom & Canvas Background Controls */}
          <div className="pointer-events-auto flex items-center gap-2 bg-black/60 backdrop-blur-md border border-white/10 p-1 rounded-full shadow-xl">
            <div className="flex items-center px-2 border-r border-white/10">
              <button
                onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}
                className="w-6 h-6 flex items-center justify-center text-white/60 hover:text-white transition-colors text-xs font-bold"
                title="Zoom Out"
              >
                -
              </button>
              <span className="text-[10px] font-mono w-10 text-center text-white/90">{Math.round(zoom * 100)}%</span>
              <button
                onClick={() => setZoom(z => Math.min(3, z + 0.25))}
                className="w-6 h-6 flex items-center justify-center text-white/60 hover:text-white transition-colors text-xs font-bold"
                title="Zoom In"
              >
                +
              </button>
              <button
                onClick={() => setZoom(1)}
                className="text-[9px] text-white/40 hover:text-white px-1 ml-1"
                title="Reset Zoom"
              >
                Reset
              </button>
            </div>

            {/* Background Selector */}
            <div className="flex items-center gap-1 px-1">
              <button
                onClick={() => setStageBg("checker")}
                className={`w-5 h-5 rounded-full border border-white/20 bg-checkerboard ${stageBg === "checker" ? "ring-2 ring-[var(--accent)]" : "opacity-60"}`}
                title="Transparency Checkerboard Grid"
              />
              <button
                onClick={() => setStageBg("dark")}
                className={`w-5 h-5 rounded-full border border-white/20 bg-zinc-900 ${stageBg === "dark" ? "ring-2 ring-[var(--accent)]" : "opacity-60"}`}
                title="Dark Grid Background"
              />
              <button
                onClick={() => setStageBg("light")}
                className={`w-5 h-5 rounded-full border border-zinc-400 bg-slate-100 ${stageBg === "light" ? "ring-2 ring-[var(--accent)]" : "opacity-60"}`}
                title="Light Grid Background"
              />
              <button
                onClick={() => setStageBg("black")}
                className={`w-5 h-5 rounded-full border border-white/20 bg-black ${stageBg === "black" ? "ring-2 ring-[var(--accent)]" : "opacity-60"}`}
                title="Solid Black Background"
              />
            </div>
          </div>
        </div>

        {/* State 1: Idle Empty State */}
        {!img && !activeJobs.length && (
          <div className="text-center opacity-30 select-none max-w-sm p-6 animate-in fade-in">
            <div className="w-16 h-16 rounded-2xl border border-white/20 flex items-center justify-center mx-auto mb-4 bg-white/5 shadow-2xl">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <p className="text-base font-semibold tracking-wide uppercase text-white/80">Interactive Stage</p>
            <p className="text-xs text-white/50 mt-1">Upload raster or SVG artwork to preview vector output</p>
          </div>
        )}

        {/* State 2 & 3: Active Stage with Before/After Split View */}
        {(img || activeJobs.length > 0) && (
          <div
            className="relative w-full h-full flex items-center justify-center p-12 transition-transform duration-200"
            style={{ transform: `scale(${zoom})` }}
          >

            {/* Original Raster Artwork (Before) with Pixel-Aligned Quantized Pre-step Canvas */}
            <div className={`absolute inset-12 flex items-center justify-center transition-all duration-700 ${running ? 'blur-sm opacity-40 grayscale-[30%]' : 'opacity-100'}`}>
              {showQuantizedPreview ? (
                <canvas
                  ref={quantizedCanvasRef}
                  style={{ aspectRatio: img ? `${img.w} / ${img.h}` : undefined }}
                  className="max-w-full max-h-full object-contain rounded-lg drop-shadow-2xl pointer-events-auto"
                />
              ) : img ? (
                <img
                  src={img.url}
                  onClick={onStageImageClick}
                  style={{ aspectRatio: img ? `${img.w} / ${img.h}` : undefined }}
                  className="max-w-full max-h-full object-contain cursor-crosshair drop-shadow-xl hover:ring-2 hover:ring-[var(--accent)]/50 rounded-lg transition-all"
                  alt="Source Artwork"
                  title="Click image to sample color layer"
                />
              ) : null}
            </div>

            {/* Rendered SVG Vector Output (After) with Clip Path for Slider */}
            {activeJobs.length > 0 && (
              <div
                className={`absolute inset-12 flex items-center justify-center ${isAnimatingReveal ? 'transition-all duration-700 ease-in-out' : 'transition-none'}`}
                style={{ clipPath: `inset(0 0 0 ${sliderPos}%)` }}
              >
                {renderProgressiveSvg()}
              </div>
            )}

            {/* Split Slider Control Handle */}
            {!running && results.length > 0 && (
              <div
                className={`absolute top-0 bottom-0 z-20 flex items-center justify-center cursor-ew-resize group ${isAnimatingReveal ? 'transition-all duration-700 ease-in-out' : 'transition-none'}`}
                style={{ left: `${sliderPos}%`, transform: 'translateX(-50%)' }}
              >
                <div className="w-0.5 h-full bg-white/70 group-hover:bg-[var(--accent)] transition-colors shadow-[0_0_12px_rgba(255,255,255,0.8)]"></div>
                <div className="absolute w-9 h-9 rounded-full bg-[var(--panel)] border-2 border-white/40 flex items-center justify-center shadow-2xl backdrop-blur-md group-hover:border-[var(--accent)] group-hover:scale-110 transition-all">
                  <div className="w-4 h-4 flex justify-between px-0.5 items-center opacity-70">
                    <div className="w-0.5 h-3 bg-white rounded-full"></div>
                    <div className="w-0.5 h-3 bg-white rounded-full"></div>
                  </div>
                </div>
              </div>
            )}

            {/* Stage Side Indicator Badges */}
            {!running && results.length > 0 && (
              <>
                <div className="absolute bottom-8 left-8 pointer-events-none bg-black/60 backdrop-blur border border-white/10 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider text-white/70">
                  Original Raster
                </div>
                <div className="absolute bottom-8 right-8 pointer-events-none bg-[var(--accent)]/20 backdrop-blur border border-[var(--accent)]/40 px-3 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                  Vector Output
                </div>
              </>
            )}

          </div>
        )}
      </div>

    </div>
  );
}
