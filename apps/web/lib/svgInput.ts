// Stage 0 for SVG inputs: a real parser (browser DOMParser, not regex; gotcha 1)
// with an ARC-SAFE path scaler (gotcha 2). Handles the two real cases from the spec:
//   1. raster-in-a-wrapper: base64 <image> elements (optionally via <use> + x/y),
//      composited to a canvas the palette picker can sample.
//   2. genuine vector <path>/<rect> passthrough, style-inlined and safely scaled.
// This replaces the provisional regex scaler that could corrupt arcs.

export type RasterPlacement = { href: string; x: number; y: number; w: number; h: number };
export type VectorPath = {
  d: string;
  fill: string;
  stroke?: string;
  strokeWidth?: string;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  strokeMiterlimit?: string;
  strokeOpacity?: string;
  fillOpacity?: string;
  opacity?: string;
};

export type SvgInput = {
  width: number;
  height: number;
  viewBox: [number, number, number, number];
  rasters: RasterPlacement[];
  vectors: VectorPath[];
  paintDefs: string;
  fullCanvasRects: { fill: string }[];
  unsupported: string[]; // element tags we didn't handle, for honest UI reporting
};

function num(v: string | null, d = 0): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : d;
}

type Presentation = Record<string, string>;
const presentationProperties = new Set([
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-opacity", "fill-opacity", "opacity",
  "stop-color", "stop-opacity",
]);

function declarations(value: string): Presentation {
  const result: Presentation = {};
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = declaration.slice(colon + 1).trim();
    if (propertyValue && presentationProperties.has(property)) result[property] = propertyValue;
  }
  return result;
}

function buildPresentationStyleMap(doc: Document): Map<string, Presentation> {
  const map = new Map<string, Presentation>();
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    for (const match of (style.textContent || "").matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g))
      map.set(match[1], declarations(match[2]));
  }
  return map;
}

function resolvePresentation(el: Element, property: string, styleMap: Map<string, Presentation>, fallback: string): string {
  let current: Element | null = el;
  while (current) {
    const attr = current.getAttribute(property);
    if (attr && attr !== "inherit") return attr;
    const inline = declarations(current.getAttribute("style") || "")[property];
    if (inline && inline !== "inherit") return inline;
    for (const cls of (current.getAttribute("class") || "").split(/\s+/)) {
      const value = styleMap.get(cls)?.[property];
      if (value && value !== "inherit") return value;
    }
    current = current.parentElement;
  }
  return fallback;
}

function vectorPresentation(el: Element, styleMap: Map<string, Presentation>): Omit<VectorPath, "d"> {
  const stroke = resolvePresentation(el, "stroke", styleMap, "none");
  return {
    fill: resolvePresentation(el, "fill", styleMap, "#000000"),
    ...(stroke !== "none" ? {
      stroke,
      strokeWidth: resolvePresentation(el, "stroke-width", styleMap, "1"),
      strokeLinecap: resolvePresentation(el, "stroke-linecap", styleMap, "butt"),
      strokeLinejoin: resolvePresentation(el, "stroke-linejoin", styleMap, "miter"),
      strokeMiterlimit: resolvePresentation(el, "stroke-miterlimit", styleMap, "4"),
      strokeOpacity: resolvePresentation(el, "stroke-opacity", styleMap, "1"),
    } : {}),
    fillOpacity: resolvePresentation(el, "fill-opacity", styleMap, "1"),
    opacity: resolvePresentation(el, "opacity", styleMap, "1"),
  };
}

function escapeXmlAttr(value: string): string {
  return value.replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
}

function serializePaintDefs(doc: Document): string {
  const gradientAttrs = new Set([
    "id", "x1", "y1", "x2", "y2", "cx", "cy", "r", "fx", "fy", "fr",
    "gradientUnits", "gradientTransform", "spreadMethod",
  ]);
  const attrs = (el: Element) => Array.from(el.attributes)
    .filter((attr) => gradientAttrs.has(attr.name))
    .map((attr) => ` ${attr.name}="${escapeXmlAttr(attr.value)}"`)
    .join("");
  return Array.from(doc.querySelectorAll("defs linearGradient, defs radialGradient"))
    .map((gradient) => {
      const tag = gradient.tagName;
      const stops = Array.from(gradient.children)
        .filter((child) => child.tagName.toLowerCase() === "stop")
        .map((stop) => {
          const offset = stop.getAttribute("offset");
          const stopStyle = declarations(stop.getAttribute("style") || "");
          const color = stop.getAttribute("stop-color") || stopStyle["stop-color"];
          const opacity = stop.getAttribute("stop-opacity") || stopStyle["stop-opacity"];
          return `<stop${offset ? ` offset="${escapeXmlAttr(offset)}"` : ""}${color ? ` stop-color="${escapeXmlAttr(color)}"` : ""}${opacity ? ` stop-opacity="${escapeXmlAttr(opacity)}"` : ""}/>`;
        }).join("");
      return `<${tag}${attrs(gradient)}>${stops}</${tag}>`;
    }).join("");
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

  const styleMap = buildPresentationStyleMap(doc);
  const paintDefs = serializePaintDefs(doc);
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
            if (d && px === 0 && py === 0) vectors.push({ d, ...vectorPresentation(target, styleMap) });
            else if (d) unsupported.add("path(translate)");
          } else if (["rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(target.tagName.toLowerCase())) {
            const px = ux + targetTranslation[0], py = uy + targetTranslation[1];
            const d = primitiveToPath(target, px, py);
            if (d) vectors.push({ d, ...vectorPresentation(target, styleMap) });
            else unsupported.add(`${target.tagName.toLowerCase()}(geometry)`);
          } else walk(target, ux + targetTranslation[0], uy + targetTranslation[1], true);
          activeUses.delete(target);
          break;
        }
        case "path": {
          const d = el.getAttribute("d");
          if (d && tx === 0 && ty === 0) vectors.push({ d, ...vectorPresentation(el, styleMap) });
          else if (d) unsupported.add("path(translate)");
          break;
        }
        case "rect": {
          const w = num(el.getAttribute("width")), h = num(el.getAttribute("height"));
          const hasRoundedCorners = num(el.getAttribute("rx")) > 0 || num(el.getAttribute("ry")) > 0;
          if (w >= W - 1 && h >= H - 1 && tx === 0 && ty === 0 && !hasRoundedCorners)
            fullCanvasRects.push({ fill: resolvePresentation(el, "fill", styleMap, "#000000") });
          else vectors.push({ d: rectToPath(el, tx, ty), ...vectorPresentation(el, styleMap) });
          break;
        }
        case "circle": case "ellipse": case "line": case "polyline": case "polygon": {
          const d = primitiveToPath(el, tx, ty);
          if (d) vectors.push({ d, ...vectorPresentation(el, styleMap) });
          else unsupported.add(`${tag}(geometry)`);
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

  return { width: W, height: H, viewBox: vb, rasters, vectors, paintDefs, fullCanvasRects, unsupported: [...unsupported] };
}

function rectToPath(el: Element, dx = 0, dy = 0): string {
  const x = dx + num(el.getAttribute("x")), y = dy + num(el.getAttribute("y"));
  const w = num(el.getAttribute("width")), h = num(el.getAttribute("height"));
  let rx = num(el.getAttribute("rx")), ry = num(el.getAttribute("ry"));
  if (rx && !ry) ry = rx;
  if (ry && !rx) rx = ry;
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (rx && ry)
    return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
}

function primitiveToPath(el: Element, dx = 0, dy = 0): string | null {
  const tag = el.tagName.toLowerCase();
  if (tag === "rect") return rectToPath(el, dx, dy);
  if (tag === "line") {
    const x1 = dx + num(el.getAttribute("x1")), y1 = dy + num(el.getAttribute("y1"));
    const x2 = dx + num(el.getAttribute("x2")), y2 = dy + num(el.getAttribute("y2"));
    return `M${x1} ${y1}L${x2} ${y2}`;
  }
  if (tag === "circle" || tag === "ellipse") {
    const cx = dx + num(el.getAttribute("cx")), cy = dy + num(el.getAttribute("cy"));
    const rx = tag === "circle" ? num(el.getAttribute("r")) : num(el.getAttribute("rx"));
    const ry = tag === "circle" ? rx : num(el.getAttribute("ry"));
    if (rx <= 0 || ry <= 0) return null;
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
  }
  if (tag === "polyline" || tag === "polygon") {
    const values = (el.getAttribute("points") || "").match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)?.map(Number) || [];
    if (values.length < 4 || values.length % 2 !== 0) return null;
    const pairs: string[] = [];
    for (let index = 0; index < values.length; index += 2)
      pairs.push(`${values[index] + dx} ${values[index + 1] + dy}`);
    return `M${pairs[0]}${pairs.slice(1).map((pair) => `L${pair}`).join("")}${tag === "polygon" ? "Z" : ""}`;
  }
  return null;
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
// For A/a (elliptical arc): scales rx, ry, x, y, while leaving x-rotation and the two
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
      // Scale rx, ry, x, y, but not rotation or flags.
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

export function scalePaintDefs(markup: string, k: number, dx = 0, dy = 0): string {
  if (!markup || (k === 1 && dx === 0 && dy === 0)) return markup;
  const transform = `scale(${k})${dx || dy ? ` translate(${dx} ${dy})` : ""}`;
  return markup.replace(/<(linearGradient|radialGradient)\b([^>]*)>/g, (opening, tag: string, attrs: string) => {
    if (!/\bgradientUnits="userSpaceOnUse"/.test(attrs)) return opening;
    if (/\bgradientTransform="/.test(attrs))
      return `<${tag}${attrs.replace(/\bgradientTransform="([^"]*)"/, `gradientTransform="${transform} $1"`)}>`;
    return `<${tag}${attrs} gradientTransform="${transform}">`;
  });
}

export function scaleStrokeWidth(value: string | undefined, k: number): string | undefined {
  if (!value) return undefined;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(value);
  return match ? `${Number(match[1]) * k}${match[2]}` : value;
}
