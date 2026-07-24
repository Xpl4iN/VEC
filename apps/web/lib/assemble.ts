// Assemble the final SVG from per-layer path data (emitted at 2× source px by the
// pipeline's beziers_to_d scale=2.0). Layers are drawn in the given stacking order.
//
// Genuine-vector SVG inputs are parsed through the arc-safe Stage 0 path.

export type AssembledLayer = {
  id: string;
  fill: string;
  d: string;
  stroke?: string;
  strokeWidth?: string;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  strokeMiterlimit?: string;
  strokeOpacity?: string;
  fillOpacity?: string;
  opacity?: string;
  editableComponents?: boolean;
};
export type ComponentStacking = "palette" | "large-first";

type Point = [number, number];

type ParsedSubpath = {
  d: string;
  points: Point[];
  area: number;
  bounds: [number, number, number, number];
  parent: number | null;
  depth: number;
};

const pathNumber = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function flattenGeneratedSubpath(d: string): Point[] | null {
  const tokens = d.match(/[MCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi);
  if (!tokens || tokens[0] !== "M") return null;
  let i = 1;
  const read = () => {
    const token = tokens[i++];
    return token != null && pathNumber.test(token) ? Number(token) : Number.NaN;
  };
  const start: Point = [read(), read()];
  if (!Number.isFinite(start[0]) || !Number.isFinite(start[1])) return null;
  const points: Point[] = [start];
  let current = start;
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === "Z") break;
    if (command !== "C") return null;
    const c1: Point = [read(), read()];
    const c2: Point = [read(), read()];
    const end: Point = [read(), read()];
    if (![...c1, ...c2, ...end].every(Number.isFinite)) return null;
    for (let step = 1; step <= 8; step++) {
      const t = step / 8;
      const mt = 1 - t;
      points.push([
        mt ** 3 * current[0] + 3 * mt ** 2 * t * c1[0] + 3 * mt * t ** 2 * c2[0] + t ** 3 * end[0],
        mt ** 3 * current[1] + 3 * mt ** 2 * t * c1[1] + 3 * mt * t ** 2 * c2[1] + t ** 3 * end[1],
      ]);
    }
    current = end;
  }
  return points.length >= 4 ? points : null;
}

function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(sum) / 2;
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const crosses = (yi > point[1]) !== (yj > point[1]);
    if (crosses && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The generated-path contract is absolute M/C/Z. Split disconnected islands
// into editor-selectable objects, but keep each hole in the same path as its
// containing outer contour so counters in letters remain transparent.
export function splitEditableComponents(d: string): string[] {
  const chunks = d.match(/M[^M]*Z/gi);
  if (!chunks || chunks.length < 2) return d.trim() ? [d] : [];
  if (chunks.join("").replace(/\s+/g, "") !== d.replace(/\s+/g, "")) return [d];

  const parsed: ParsedSubpath[] = [];
  for (const chunk of chunks) {
    const points = flattenGeneratedSubpath(chunk);
    if (!points) return [d];
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    parsed.push({
      d: chunk,
      points,
      area: polygonArea(points),
      bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
      parent: null,
      depth: 0,
    });
  }

  for (let i = 0; i < parsed.length; i++) {
    const probe = parsed[i].points[0];
    let parent: number | null = null;
    for (let j = 0; j < parsed.length; j++) {
      if (i === j || parsed[j].area <= parsed[i].area) continue;
      const [x0, y0, x1, y1] = parsed[j].bounds;
      if (probe[0] <= x0 || probe[0] >= x1 || probe[1] <= y0 || probe[1] >= y1) continue;
      if (!pointInPolygon(probe, parsed[j].points)) continue;
      if (parent == null || parsed[j].area < parsed[parent].area) parent = j;
    }
    parsed[i].parent = parent;
  }

  const depthOf = (index: number): number => {
    let depth = 0;
    let parent = parsed[index].parent;
    const seen = new Set<number>();
    while (parent != null && !seen.has(parent)) {
      seen.add(parent);
      depth++;
      parent = parsed[parent].parent;
    }
    return depth;
  };
  parsed.forEach((subpath, index) => {
    subpath.depth = depthOf(index);
  });

  const components: string[] = [];
  parsed.forEach((subpath, index) => {
    if (subpath.depth % 2 !== 0) return;
    const holes = parsed
      .filter((candidate) => candidate.parent === index && candidate.depth === subpath.depth + 1)
      .map((candidate) => candidate.d);
    components.push([subpath.d, ...holes].join(""));
  });
  return components.length ? components : [d];
}

function componentArea(d: string): number {
  const outer = d.match(/M[^M]*Z/i)?.[0];
  if (!outer) return 0;
  const points = flattenGeneratedSubpath(outer);
  return points ? polygonArea(points) : 0;
}

export function assembleLayers(
  layers: AssembledLayer[],
  viewBox: string,
  bgFill?: string | null,
  stacking: ComponentStacking = "palette",
  paintDefs = "",
): string {
  const parts = viewBox.trim().split(/\s+/);
  const w = parts[2] ?? "100";
  const h = parts[3] ?? "100";
  const bgRect = bgFill ? `    <rect width="${w}" height="${h}" fill="${escapeAttr(bgFill)}"/>\n` : "";
  const components = layers
    .flatMap((layer, layerIndex) => {
      const components = layer.editableComponents ? splitEditableComponents(layer.d) : [layer.d];
      return components.map((d, index) => {
        const id = components.length === 1 ? layer.id : `${layer.id}-${index + 1}`;
        return { ...layer, id, d, area: componentArea(d), layerIndex, componentIndex: index };
      });
    });
  if (stacking === "large-first") {
    components.sort((a, b) =>
      b.area - a.area || a.layerIndex - b.layerIndex || a.componentIndex - b.componentIndex);
  }
  const paths = components
    .map(({ id, fill, d, stroke, strokeWidth, strokeLinecap, strokeLinejoin, strokeMiterlimit, strokeOpacity, fillOpacity, opacity }) => {
      const presentation = [
        `fill="${escapeAttr(fill)}"`,
        `fill-rule="evenodd"`,
        stroke && `stroke="${escapeAttr(stroke)}"`,
        strokeWidth && `stroke-width="${escapeAttr(strokeWidth)}"`,
        strokeLinecap && `stroke-linecap="${escapeAttr(strokeLinecap)}"`,
        strokeLinejoin && `stroke-linejoin="${escapeAttr(strokeLinejoin)}"`,
        strokeMiterlimit && `stroke-miterlimit="${escapeAttr(strokeMiterlimit)}"`,
        strokeOpacity && strokeOpacity !== "1" && `stroke-opacity="${escapeAttr(strokeOpacity)}"`,
        fillOpacity && fillOpacity !== "1" && `fill-opacity="${escapeAttr(fillOpacity)}"`,
        opacity && opacity !== "1" && `opacity="${escapeAttr(opacity)}"`,
      ].filter(Boolean).join(" ");
      return `    <path id="${escapeAttr(id)}" ${presentation} d="${d}"/>`;
    })
    .join("\n");
  const defs = paintDefs ? `  <defs>${paintDefs}</defs>` : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">`,
    defs,
    `  <g id="artwork">`,
    bgRect ? bgRect + paths : paths,
    `  </g>`,
    `</svg>`,
    ``,
  ].join("\n");
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// PROVISIONAL: blind numeric scale of d payloads. Flagged in UI. Not arc-safe.
export function provisionalScaleD(svgGroup: string, k: number, classFill: Record<string, string>): string {
  return svgGroup
    .replace(/d="([^"]+)"/g, (_m, d: string) =>
      'd="' + d.replace(/-?\d*\.?\d+(?:[eE]-?\d+)?/g, (n) => String(+n * k)) + '"')
    .replace(/class="(s\d)"/g, (_m, c: string) => `fill="${classFill[c] ?? "#000000"}"`);
}

export function hasArcCommand(svgText: string): boolean {
  return /d="[^"]*[Aa][^"]*"/.test(svgText);
}
