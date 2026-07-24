import assert from "node:assert/strict";
import test from "node:test";
import { bandPath, pointInRegion, profileForRegion, sampleBand } from "./regions.ts";
import type { TreatmentRegion } from "./types.ts";

const textRegion: TreatmentRegion = {
  id: "arched-text",
  name: "Arched text",
  role: "text",
  character: 0.15,
  priority: 1,
  enabled: true,
  geometry: {
    start: [10, 60],
    control: [50, 10],
    end: [90, 60],
    halfWidth: 12,
  },
};

test("a bendable band follows its quadratic centerline and creates a closed selector", () => {
  const sampled = sampleBand(textRegion, 20);
  assert.equal(sampled.center.length, 21);
  assert.deepEqual(sampled.center[0], [10, 60]);
  assert.deepEqual(sampled.center.at(-1), [90, 60]);
  assert.ok(sampled.center[10][1] < 40);
  assert.match(bandPath(textRegion), /^M.+Z$/);
  assert.equal(pointInRegion(50, 35, textRegion), true);
  assert.equal(pointInRegion(50, 90, textRegion), false);
});

test("text character changes fitting behavior without enabling gap closing", () => {
  const base = {
    smoothingCap: 1.35,
    fitError: 0.22,
    cornerWindow: 8,
    cornerAngle: 55,
    tinyCurve: 2,
    minAreaFraction: 0.0002,
  };
  const geometric = profileForRegion(textRegion, base, 2);
  const expressive = profileForRegion({ ...textRegion, character: 0.9 }, base, 2);
  assert.equal(geometric.engine, "smooth3");
  assert.equal(expressive.engine, "smooth2");
  assert.equal(geometric.useG1, true);
  assert.equal(expressive.useG1, true);
  assert.equal(geometric.gapCloseRadius, 0);
  assert.ok(geometric.quality.cornerAngle < expressive.quality.cornerAngle);
  assert.ok(geometric.quality.smoothingCap < expressive.quality.smoothingCap);
});

test("geometric regions preserve corners more aggressively than illustrations", () => {
  const base = {
    smoothingCap: 1.35,
    fitError: 0.22,
    cornerWindow: 8,
    cornerAngle: 55,
    tinyCurve: 2,
    minAreaFraction: 0.0002,
  };
  const geometric = profileForRegion({ ...textRegion, role: "geometric" }, base, 2);
  const illustration = profileForRegion({ ...textRegion, role: "illustration" }, base, 2);
  assert.equal(geometric.engine, "smooth3");
  assert.equal(illustration.engine, "smooth2");
  assert.ok(geometric.quality.cornerAngle < illustration.quality.cornerAngle);
  assert.ok(geometric.quality.fitError < illustration.quality.fitError);
});
