import type { LayerJob, TreatmentRegion } from "./types";

type Point = [number, number];
type RGB = [number, number, number];

export type RegionProfile = {
  engine: LayerJob["engine"];
  useG1: boolean;
  cfg: LayerJob["cfg"];
  quality: NonNullable<LayerJob["quality"]>;
  gapCloseRadius: number;
};

export type RegionSource = {
  key: string;
  filename: string;
  pngBase64: string;
  region: TreatmentRegion | null;
  paletteIndices: number[];
  componentCount: number;
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export function sampleBand(region: TreatmentRegion, steps = 36): { polygon: Point[]; center: Point[] } {
  const { start, control, end, halfWidth } = region.geometry;
  const center: Point[] = [];
  const upper: Point[] = [];
  const lower: Point[] = [];
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    const mt = 1 - t;
    const point: Point = [
      mt * mt * start[0] + 2 * mt * t * control[0] + t * t * end[0],
      mt * mt * start[1] + 2 * mt * t * control[1] + t * t * end[1],
    ];
    const tangent: Point = [
      2 * mt * (control[0] - start[0]) + 2 * t * (end[0] - control[0]),
      2 * mt * (control[1] - start[1]) + 2 * t * (end[1] - control[1]),
    ];
    const length = Math.hypot(tangent[0], tangent[1]) || 1;
    const normal: Point = [-tangent[1] / length, tangent[0] / length];
    center.push(point);
    upper.push([point[0] + normal[0] * halfWidth, point[1] + normal[1] * halfWidth]);
    lower.push([point[0] - normal[0] * halfWidth, point[1] - normal[1] * halfWidth]);
  }
  return { center, polygon: [...upper, ...lower.reverse()] };
}

export function bandPath(region: TreatmentRegion): string {
  const { polygon } = sampleBand(region);
  return polygon.map((point, index) => `${index ? "L" : "M"}${point[0].toFixed(2)} ${point[1].toFixed(2)}`).join("") + "Z";
}

export function centerPath(region: TreatmentRegion): string {
  const { start, control, end } = region.geometry;
  return `M${start[0]} ${start[1]}Q${control[0]} ${control[1]} ${end[0]} ${end[1]}`;
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInRegion(x: number, y: number, region: TreatmentRegion): boolean {
  return pointInPolygon(x, y, sampleBand(region, 28).polygon);
}

export function profileForRegion(
  region: TreatmentRegion | null,
  base: NonNullable<LayerJob["quality"]>,
  scale: number,
): RegionProfile {
  const capVal = Math.max(0.25, 2 / Math.max(1, scale / 2));
  const tolVal = Math.max(0.2, 1 / Math.max(1, scale / 2));
  if (!region || region.role === "custom") {
    return { engine: "smooth2", useG1: true, cfg: null, quality: { ...base }, gapCloseRadius: 0 };
  }
  if (region.role === "geometric") {
    return {
      engine: "smooth3",
      useG1: true,
      cfg: [capVal, tolVal, false, 8, 1e9],
      quality: {
        ...base,
        smoothingCap: Math.min(base.smoothingCap, 0.5),
        fitError: Math.min(base.fitError, 0.08),
        cornerWindow: Math.max(4, base.cornerWindow),
        cornerAngle: Math.min(38, base.cornerAngle),
        tinyCurve: Math.min(base.tinyCurve, 1),
      },
      gapCloseRadius: 0,
    };
  }
  if (region.role === "illustration") {
    return {
      engine: "smooth2",
      useG1: true,
      cfg: null,
      quality: {
        ...base,
        smoothingCap: Math.min(base.smoothingCap, 0.9),
        fitError: Math.min(base.fitError, 0.14),
        cornerWindow: Math.max(5, base.cornerWindow),
        cornerAngle: Math.min(50, base.cornerAngle),
        tinyCurve: Math.min(base.tinyCurve, 1.25),
      },
      gapCloseRadius: 0,
    };
  }
  const character = clamp01(region.character);
  return {
    engine: character < 0.28 ? "smooth3" : "smooth2",
    useG1: true,
    cfg: character < 0.28 ? [capVal, tolVal, false, 6, 1e9] : null,
    quality: {
      ...base,
      smoothingCap: Math.min(base.smoothingCap, 0.35 + character * 0.75),
      fitError: Math.min(base.fitError, 0.045 + character * 0.13),
      cornerWindow: 3.5 + character * 5.5,
      cornerAngle: 30 + character * 42,
      tinyCurve: 0.45 + character * 1.8,
      minAreaFraction: Math.min(base.minAreaFraction, 0.00003),
    },
    gapCloseRadius: 0,
  };
}

function nearestPalette(pixel: Uint8ClampedArray, offset: number, palette: RGB[]): number {
  let nearest = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < palette.length; index++) {
    const color = palette[index];
    const next =
      (pixel[offset] - color[0]) ** 2 +
      (pixel[offset + 1] - color[1]) ** 2 +
      (pixel[offset + 2] - color[2]) ** 2;
    if (next < distance) {
      distance = next;
      nearest = index;
    }
  }
  return nearest;
}

async function canvasPngBase64(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode treatment mask")), "image/png"));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index++) binary += String.fromCharCode(bytes[index]);
  return btoa(binary);
}

export async function buildRegionSources(
  canvas: HTMLCanvasElement,
  palette: RGB[],
  regions: TreatmentRegion[],
  activePaletteIndices: number[] = palette.map((_, index) => index),
): Promise<RegionSource[]> {
  const active = new Set(activePaletteIndices);
  const enabled = regions.filter((region) => region.enabled).sort((a, b) => b.priority - a.priority);
  if (!enabled.length) {
    return [{
      key: "default",
      filename: "user.png",
      pngBase64: await canvasPngBase64(canvas),
      region: null,
      paletteIndices: activePaletteIndices,
      componentCount: 0,
    }];
  }

  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas context unavailable");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const total = canvas.width * canvas.height;
  const assignment = new Int16Array(total);
  assignment.fill(-1);
  for (let pixel = 0; pixel < total; pixel++) {
    const offset = pixel * 4;
    if (image.data[offset + 3] < 50) continue;
    const nearest = nearestPalette(image.data, offset, palette);
    if (active.has(nearest)) assignment[pixel] = nearest;
  }

  const groupByPixel = new Int16Array(total);
  groupByPixel.fill(-2);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const componentCounts = new Array(enabled.length + 1).fill(0);
  const paletteSets = Array.from({ length: enabled.length + 1 }, () => new Set<number>());
  const regionPolygons = enabled.map((region) => sampleBand(region, 28).polygon);
  const regionBounds = regionPolygons.map((polygon) => {
    const xs = polygon.map((point) => point[0]);
    const ys = polygon.map((point) => point[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] as const;
  });

  for (let start = 0; start < total; start++) {
    const color = assignment[start];
    if (color < 0 || visited[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    visited[start] = 1;
    const pixels: number[] = [];
    const overlaps = new Int32Array(enabled.length);
    while (head < tail) {
      const pixel = queue[head++];
      pixels.push(pixel);
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      for (let regionIndex = 0; regionIndex < enabled.length; regionIndex++) {
        const bounds = regionBounds[regionIndex];
        if (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3]) continue;
        if (pointInPolygon(x + 0.5, y + 0.5, regionPolygons[regionIndex])) overlaps[regionIndex]++;
      }
      const neighbors = [
        x > 0 ? pixel - 1 : -1,
        x + 1 < canvas.width ? pixel + 1 : -1,
        pixel >= canvas.width ? pixel - canvas.width : -1,
        pixel + canvas.width < total ? pixel + canvas.width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor < 0 || visited[neighbor] || assignment[neighbor] !== color) continue;
        visited[neighbor] = 1;
        queue[tail++] = neighbor;
      }
    }
    let group = enabled.length;
    let strongest = 0;
    for (let regionIndex = 0; regionIndex < overlaps.length; regionIndex++) {
      if (overlaps[regionIndex] > strongest) {
        strongest = overlaps[regionIndex];
        group = regionIndex;
      }
    }
    if (strongest / pixels.length < 0.08) group = enabled.length;
    for (const pixel of pixels) groupByPixel[pixel] = group;
    componentCounts[group]++;
    paletteSets[group].add(color);
  }

  const sources: RegionSource[] = [];
  for (let group = 0; group <= enabled.length; group++) {
    if (!componentCounts[group]) continue;
    const target = document.createElement("canvas");
    target.width = canvas.width;
    target.height = canvas.height;
    const targetContext = target.getContext("2d")!;
    const masked = new ImageData(new Uint8ClampedArray(image.data), canvas.width, canvas.height);
    for (let pixel = 0; pixel < total; pixel++) {
      if (groupByPixel[pixel] !== group) masked.data[pixel * 4 + 3] = 0;
    }
    targetContext.putImageData(masked, 0, 0);
    const region = group < enabled.length ? enabled[group] : null;
    const key = region?.id ?? "default";
    sources.push({
      key,
      filename: `region-${key}.png`,
      pngBase64: await canvasPngBase64(target),
      region,
      paletteIndices: [...paletteSets[group]],
      componentCount: componentCounts[group],
    });
  }
  return sources;
}
