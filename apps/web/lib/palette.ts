export type WeightedColor = {
  rgb: [number, number, number];
  count: number;
};

const distanceSquared = (
  a: [number, number, number],
  b: [number, number, number],
) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

const luminance = ([r, g, b]: [number, number, number]) =>
  0.299 * r + 0.587 * g + 0.114 * b;

// Consolidate antialias and resampling shades into the dominant source color.
// Colors are compared only with the dominant anchor, not transitively, so an
// intermediate shade cannot bridge two intentional design colors.
export function consolidateSimilarColors(
  colors: WeightedColor[],
  threshold: number,
): WeightedColor[] {
  const ordered = colors
    .map((color, index) => ({ ...color, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
  const consumed = new Set<number>();
  const thresholdSquared = threshold ** 2;
  const consolidated: WeightedColor[] = [];

  for (const anchor of ordered) {
    if (consumed.has(anchor.index)) continue;
    let count = anchor.count;
    consumed.add(anchor.index);
    for (const candidate of ordered) {
      if (consumed.has(candidate.index)) continue;
      if (distanceSquared(anchor.rgb, candidate.rgb) > thresholdSquared) continue;
      consumed.add(candidate.index);
      count += candidate.count;
    }
    consolidated.push({ rgb: anchor.rgb, count });
  }

  return consolidated.sort((a, b) => luminance(b.rgb) - luminance(a.rgb));
}
