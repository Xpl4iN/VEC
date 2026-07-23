// Stage 0 for SVG inputs — a REAL parser (browser DOMParser, not regex; gotcha 1)
// with an ARC-SAFE path scaler (gotcha 2). Handles the two real cases from the spec:
//   1. raster-in-a-wrapper: base64 <image> elements (optionally via <use> + x/y),
//      composited to a canvas the palette picker can sample.
//   2. genuine vector <path>/<rect> passthrough, style-inlined and safely scaled.
// This replaces the provisional regex scaler that could corrupt arcs.

export type RasterPlacement = { href: string; x: number; y: number; w: number; h: number };
export type VectorPath = { d: string; fill: string };

export type SvgInput = {
  width: number;
  height: number;
  viewBox: [number, number, number, number];
  rasters: RasterPlacement[];
  vectors: VectorPath[];
  fullCanvasRects: { fill: string }[];
  unsupported: string[]; // element tags we didn't handle, for honest UI reporting
};

function num(v: string | null, d = 0): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : d;
}

// Resolve `<style>.cls{fill:..}` + class="" and inline style="fill:.." to a hex/color.
function resolveFill(el: Element, styleMap: Map<string, string>): string {
  const attr = el.getAttribute("fill");
  if (attr && attr !== "inherit") return attr;
  const inline = /fill:\s*([^;]+)/.exec(el.getAttribute("style") || "");
  if (inline) return inline[1].trim();
  for (const cls of (el.getAttribute("class") || "").split(/\s+/)) {
    const f = styleMap.get(cls);
    if (f) return f;
  }
  return "#000000";
}

function buildStyleMap(doc: Document): Map<string, string> {
  const map = new Map<string, string>();
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const css = style.textContent || "";
    // .cls { fill: #rrggbb } — parsed with a scoped regex over CSS text (not the SVG tree)
    for (const m of css.matchAll(/\.([\w-]+)\s*\{[^}]*?fill:\s*([^;}\s]+)/g)) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

function translateOf(el: Element): [number, number] | null {
  const value = el.getAttribute("transform");
  if (!value) return [0, 0];
  const match = /^\s*translate\(\s*([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?)\s*(?:[,\s]\s*([+-]?(?:\d*\.?\d+)(?:e[+-]?\d+)?))?\s*\)\s*$/i.exec(value);
  return match ? [Number(match[1]), Number(match[2] ?? 0)] : null;
}

export function parseSvgInput(text: string): SvgInput {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const err = doc.querySelector("parsererror");
  if (err) throw new Error("Invalid SVG: " + (err.textContent || "").slice(0, 120));
  const svg = doc.documentElement;

  let vb: [number, number, number, number];
  const vbAttr = svg.getAttribute("viewBox");
  if (vbAttr) { const p = vbAttr.split(/[\s,]+/).map(Number); vb = [p[0], p[1], p[2], p[3]]; }
  else vb = [0, 0, num(svg.getAttribute("width"), 100), num(svg.getAttribute("height"), 100)];
  const [, , W, H] = vb;

  const styleMap = buildStyleMap(doc);
  const defs = new Map<string, Element>();
  for (const el of Array.from(doc.querySelectorAll("[id]"))) defs.set(el.getAttribute("id")!, el);

  const rasters: RasterPlacement[] = [];
  const vectors: VectorPath[] = [];
  const fullCanvasRects: { fill: string }[] = [];
  const unsupported = new Set<string>();

  const href = (el: Element) => el.getAttribute("href") || el.getAttribute("xlink:href") || "";

  const emitImage = (el: Element, dx: number, dy: number) => {
    const h = href(el);
    if (!h.startsWith("data:")) { unsupported.add("image(non-data-uri)"); return; }
    rasters.push({
      href: h,
      x: dx + num(el.getAttribute("x")), y: dy + num(el.getAttribute("y")),
      w: num(el.getAttribute("width"), W), h: num(el.getAttribute("height"), H),
    });
  };

  const activeUses = new Set<Element>();
  const walk = (node: Element, dx = 0, dy = 0, referenced = false) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase();
      const translated = translateOf(el);
      if (!translated) {
        unsupported.add(`${tag}(transform)`);
        continue;
      }
      const tx = dx + translated[0], ty = dy + translated[1];
      switch (tag) {
        case "image": emitImage(el, tx, ty); break;
        case "use": {
          const target = defs.get((href(el).replace("#", "")));
          if (!target) {
            unsupported.add("use->?");
            break;
          }
          if (activeUses.has(target)) {
            unsupported.add("use(cycle)");
            break;
          }
          activeUses.add(target);
          const ux = tx + num(el.getAttribute("x")), uy = ty + num(el.getAttribute("y"));
          const targetTranslation = translateOf(target);
          if (!targetTranslation) unsupported.add(`${target.tagName.toLowerCase()}(transform)`);
          else if (target.tagName.toLowerCase() === "image")
            emitImage(target, ux + targetTranslation[0], uy + targetTranslation[1]);
          else if (target.tagName.toLowerCase() === "path") {
            const d = target.getAttribute("d");
            const px = ux + targetTranslation[0], py = uy + targetTranslation[1];
            if (d && px === 0 && py === 0) vectors.push({ d, fill: resolveFill(target, styleMap) });
            else if (d) unsupported.add("path(translate)");
          } else if (target.tagName.toLowerCase() === "rect") {
            const px = ux + targetTranslation[0], py = uy + targetTranslation[1];
            vectors.push({ d: rectToPath(target, px, py), fill: resolveFill(target, styleMap) });
          } else walk(target, ux + targetTranslation[0], uy + targetTranslation[1], true);
          activeUses.delete(target);
          break;
        }
        case "path": {
          const d = el.getAttribute("d");
          if (d && tx === 0 && ty === 0) vectors.push({ d, fill: resolveFill(el, styleMap) });
          else if (d) unsupported.add("path(translate)");
          break;
        }
        case "rect": {
          const w = num(el.getAttribute("width")), h = num(el.getAttribute("height"));
          if (w >= W - 1 && h >= H - 1 && tx === 0 && ty === 0) fullCanvasRects.push({ fill: resolveFill(el, styleMap) });
          else vectors.push({ d: rectToPath(el, tx, ty), fill: resolveFill(el, styleMap) });
          break;
        }
        case "g": case "svg": case "symbol": walk(el, tx, ty, referenced); break;
        // Definitions are declarations, not rendered content. They are traversed
        // only when reached through a <use>.
        case "defs": if (referenced) walk(el, tx, ty, true); break;
        case "style": case "title": case "desc": case "metadata": break;
        default: unsupported.add(tag);
      }
    }
  };
  walk(svg);

  return { width: W, height: H, viewBox: vb, rasters, vectors, fullCanvasRects, unsupported: [...unsupported] };
}

function rectToPath(el: Element, dx = 0, dy = 0): string {
  const x = dx + num(el.getAttribute("x")), y = dy + num(el.getAttribute("y"));
  const w = num(el.getAttribute("width")), h = num(el.getAttribute("height"));
  return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}

// Composite the raster placements onto a canvas sized to the viewBox, so the
// palette picker can sample it and the compute treats it as one source image.
export async function compositeRasters(input: SvgInput): Promise<HTMLCanvasElement> {
  const c = document.createElement("canvas");
  c.width = Math.round(input.width); c.height = Math.round(input.height);
  const ctx = c.getContext("2d")!;
  for (const r of input.rasters) {
    const im = new Image();
    await new Promise((res, rej) => { im.onload = res; im.onerror = rej; im.src = r.href; });
    ctx.drawImage(
      im,
      r.x - input.viewBox[0],
      r.y - input.viewBox[1],
      r.w || im.naturalWidth,
      r.h || im.naturalHeight,
    );
  }
  return c;
}

// ARC-SAFE path-data scaler. Tokenises commands and scales only length operands.
// For A/a (elliptical arc): scales rx, ry, x, y — leaves x-rotation and the two
// boolean flags UNTOUCHED (spec gotcha 2). Safe for M L H V C S Q T A Z (+ rel).
export function scalePathData(d: string, k: number, dx = 0, dy = 0): string {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const out: string[] = [];
  let i = 0;
  let cmd = "";
  const isCmd = (t: string) => /^[a-zA-Z]$/.test(t);
  const readNums = (n: number) => {
    const arr: number[] = [];
    for (let j = 0; j < n && i < tokens.length && !isCmd(tokens[i]); j++) arr.push(parseFloat(tokens[i++]));
    if (arr.length !== n) throw new Error(`Invalid SVG path: ${cmd} expects ${n} operands`);
    return arr;
  };
  const emit = (c: string, nums: number[]) => out.push(c + nums.map((v) => +v.toFixed(4)).join(" "));
  const absolute = () => cmd === cmd.toUpperCase();
  const xy = (nums: number[]) => nums.map((n, index) =>
    (n + (absolute() ? (index % 2 === 0 ? dx : dy) : 0)) * k);

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    const c = cmd.toLowerCase();
    if (c === "z") { out.push(cmd); continue; }
    if (c === "h") {
      emit(cmd, readNums(1).map((n) => (n + (absolute() ? dx : 0)) * k));
    } else if (c === "v") {
      emit(cmd, readNums(1).map((n) => (n + (absolute() ? dy : 0)) * k));
    }
    else if (c === "a") {
      const [rx, ry, rot, laf, sf, x, y] = readNums(7);
      // scale rx, ry, x, y — NOT rotation, NOT flags
      emit(cmd, [
        rx * k, ry * k, rot, laf, sf,
        (x + (absolute() ? dx : 0)) * k,
        (y + (absolute() ? dy : 0)) * k,
      ]);
    } else if (c === "c") emit(cmd, xy(readNums(6)));
    else if (c === "s" || c === "q") emit(cmd, xy(readNums(4)));
    else if (c === "m" || c === "l" || c === "t") emit(cmd, xy(readNums(2)));
    else throw new Error(`Unsupported SVG path command: ${cmd}`);
  }
  return out.join("");
}
