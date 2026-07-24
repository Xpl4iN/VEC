export type Engine = "smooth2" | "smooth3";

// A single layer's compute job, sent to a pool worker.
export type LayerJob = {
  jobId: number;
  name: string;                       // unique key registered into pipeline.LAYERS
  engine: Engine;                     // smooth2 = Organic, smooth3 = Organic/Geometric
  useG1: boolean;                     // Geometric layers run g1 after
  file: string;                       // PNG filename in the worker FS
  offset: [number, number];           // pixel offset of this raster within the canvas
  palette: [number, number, number][] | null;  // shared palette for unmixing, or null = alpha
  idx: number | null;                 // which palette colour this layer extracts
  cfg: [number, number | null, boolean, number, number] | null; // smooth3 CFG tuple
  scale?: number;                     // coordinate output scale multiplier (default 2.0)
  quality?: {
    smoothingCap: number;             // max Organic drift in source pixels
    fitError: number;                 // cubic fit tolerance in source pixels
    cornerWindow: number;             // arclength used to classify corners
    cornerAngle: number;              // minimum turn angle considered a corner
    tinyCurve: number;                // absorb shorter cubic chords
    minAreaFraction: number;          // remove smaller disconnected raster regions
  };
  refinement?: {
    pass: number;                     // 1 = initial vectorization, 2/3 = refinement
    gapCloseRadius: number;           // close gaps up to roughly 2x this source-pixel radius
    edgeSmoothing: number;            // multiplier applied to the previous smoothing budget
    edgeCharacter?: "straight" | "curved" | "rounded";
    source?: "original-raster" | "previous-svg";
  };
  treatmentRegionId?: string | null;
  treatmentRole?: TreatmentRole | null;
  expected: string | null;            // optional regression path for byte-identity
  // presentation (not sent to python)
  fill: string;
  id: string;
};

export type LayerResult = {
  name: string;
  d: string;
  nodes: number;
  iou: number;
  mean: number;
  identical: boolean | null;
  secs: number;
  cleanup: Array<[number, number[]]>;
};

export type Profile = "organic" | "detailed" | "geometric";

export type TreatmentRole = "text" | "illustration" | "geometric" | "custom";

export type CurvedBand = {
  start: [number, number];
  control: [number, number];
  end: [number, number];
  halfWidth: number;
};

export type TreatmentRegion = {
  id: string;
  name: string;
  geometry: CurvedBand;
  role: TreatmentRole;
  character: number;
  priority: number;
  enabled: boolean;
};
