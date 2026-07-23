// Assemble the final SVG from per-layer path data (emitted at 2× source px by the
// pipeline's beziers_to_d scale=2.0). Layers are drawn in the given stacking order.
//
// The genuine-vector passthrough (SVG inputs) uses the PROVISIONAL regex scaler,
// safe ONLY for M/L/H/V/C/Q/T/Z — arc (A) commands would be corrupted. Flagged in
// the UI; the real parser (Gate D) replaces it. See SPEC gotcha 2.

export type AssembledLayer = { id: string; fill: string; d: string };

export function assembleLayers(layers: AssembledLayer[], viewBox: string, bgFill?: string | null): string {
  const parts = viewBox.trim().split(/\s+/);
  const w = parts[2] ?? "100";
  const h = parts[3] ?? "100";
  const bgRect = bgFill ? `    <rect width="${w}" height="${h}" fill="${escapeAttr(bgFill)}"/>\n` : "";
  const paths = layers
    // Each path remains an isolated, editable color region. A progressively
    // wider, sharp stroke closes subpixel seams only in the composited render
    // without duplicating other colors inside the named layer.
    .map((l, i) => {
      const progress = layers.length > 1 ? i / (layers.length - 1) : 1;
      const strokeWidth = (0.5 + 1.5 * progress).toFixed(2).replace(/\.?0+$/, "");
      return `    <path id="${escapeAttr(l.id)}" fill="${escapeAttr(l.fill)}" stroke="${escapeAttr(l.fill)}" stroke-width="${strokeWidth}" stroke-linejoin="miter" stroke-linecap="butt" stroke-miterlimit="2" paint-order="stroke fill" fill-rule="evenodd" d="${l.d}"/>`;
    })
    .join("\n");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}">`,
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
