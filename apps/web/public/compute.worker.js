// Compute worker — one Pyodide instance per worker. The main thread spawns a
// POOL of these (lib/pool.ts) for true multithreading: real OS threads, each with
// its own interpreter, distributing layers. Works on any static host (Vercel) —
// no server, just the COOP/COEP headers already shipped in vercel.json.
//
// Runs the validated CPython pipeline. User layers are registered by injecting
// definitions into pipeline.LAYERS and smooth3.CFG at runtime. Jobs may carry an
// optional expected path for exact regression checks.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/";
let pyodide = null;
const writtenPngs = new Set();

function post(o) { self.postMessage(o); }

async function boot(pipelineSources, pngs) {
  importScripts(PYODIDE + "pyodide.js");
  pyodide = await loadPyodide({ indexURL: PYODIDE });
  await pyodide.loadPackage(["numpy", "scipy", "scikit-image", "pillow"]);
  for (const [name, text] of Object.entries(pipelineSources)) pyodide.FS.writeFile(name, text);
  loadPngs(pngs);
  const ver = pyodide.runPython(
    "import scipy,skimage;'scipy '+scipy.__version__+' / skimage '+skimage.__version__");
  post({ type: "booted", ver });
}

function loadPngs(pngs) {
  if (!pngs) return;
  for (const [name, b64] of Object.entries(pngs)) {
    if (writtenPngs.has(name)) continue;
    pyodide.FS.writeFile(name, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    writtenPngs.add(name);
  }
}

function q(s) { return JSON.stringify(s); }
function pyPalette(p) {
  return p == null ? "None" : "[" + p.map((c) => `(${c[0]},${c[1]},${c[2]})`).join(",") + "]";
}
function pyCfg(cfg) {
  const [cap, tol, arcs, minLine, minArc] = cfg;
  return `(${cap}, ${tol == null ? "None" : tol}, ${arcs ? "True" : "False"}, ${minLine}, ${minArc})`;
}

function processJob(job) {
  const { name, engine, useG1, file, offset, palette, idx, cfg, scale } = job;
  const sVal = scale != null ? scale : 2.0;
  // 1. register the layer definition into the pipeline dicts (runtime injection)
  let inject =
    "import importlib, math, pipeline, smooth2, smooth3, g1, orient, deloop, json\n" +
    "for _m in (pipeline, smooth2, smooth3, g1, orient, deloop): importlib.reload(_m)\n" +
    `pipeline.SCALE = ${sVal}\n` +
    `pipeline.Z = min(8, max(2, int(round(4 * math.sqrt(${sVal} / 2.0)))))\n` +
    `pipeline.STEP = max(0.15, round(0.30 / math.sqrt(${sVal} / 2.0), 3))\n` +
    `smooth2.FIT_ERR = max(0.02, round(0.08 / math.sqrt(${sVal} / 2.0), 3))\n` +
    `smooth3.FIT_ERR = max(0.02, round(0.05 / math.sqrt(${sVal} / 2.0), 3))\n` +
    `pipeline.LAYERS[${q(name)}] = (${q(file)}, (${offset[0]}, ${offset[1]}), ${pyPalette(palette)}, ${idx == null ? "None" : idx})\n`;
  if (engine === "smooth3") inject += `smooth3.CFG[${q(name)}] = ${pyCfg(cfg)}\n`;
  pyodide.runPython(inject);

  // 2. run the layer's processing stages
  const calls = [];
  calls.push(engine === "smooth3" ? `smooth3.process(${q(name)})` : `smooth2.process(${q(name)})`);
  if (useG1) calls.push(`g1.process_layer(${q(name)})`);
  calls.push(`_j = json.load(open('layer_' + ${q(name)} + '.json'))`);
  calls.push(`orient.fix(_j['d'])`);
  const pathD = pyodide.runPython(calls.join("\n"));

  // 3. verify (Stage 7) against the coverage field
  const m = JSON.parse(pyodide.runPython([
    "import sys, io",
    `sys.argv = ['verify.py', ${q(name)}]`,
    "_b = io.StringIO(); _o = sys.stdout; sys.stdout = _b",
    "exec(open('verify.py').read())",
    "sys.stdout = _o",
    "_p = _b.getvalue().strip().splitlines()[0].split()",
    "json.dumps({'iou': float(_p[1].split('=')[1]), 'mean': float(_p[2].split('=')[1].rstrip('px'))})",
  ].join("\n")));

  const identical = job.expected != null ? pathD === job.expected : null;
  if (identical === false)
    throw new Error(`byte-identity FAILED on '${name}' — regime 1 broken, do not ship`);
  pyodide.globals.set("_vec_d", pathD);
  const cleanup = JSON.parse(pyodide.runPython([
    "if not deloop.parse_is_trustworthy(_vec_d):",
    "    raise ValueError('cleanup refused path data outside absolute M/C/Z contract')",
    "_vec_fixed, _vec_cleanup = deloop.deloop(_vec_d)",
    "if deloop.has_self_intersection(_vec_fixed):",
    "    raise ValueError('self-intersection survived cleanup')",
    "json.dumps({'d': _vec_fixed, 'removed': _vec_cleanup})",
  ].join("\n")));
  const d = cleanup.d;
  return {
    name, d, nodes: (d.match(/[Cc]/g) || []).length,
    iou: m.iou, mean: m.mean, identical, cleanup: cleanup.removed,
  };
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.cmd === "boot") await boot(d.pipelineSources, d.pngs);
    else if (d.cmd === "pngs") { loadPngs(d.pngs); post({ type: "pngsLoaded" }); }
    else if (d.cmd === "job") {
      const t = performance.now();
      const r = processJob(d.job);
      post({ type: "result", ...r, secs: (performance.now() - t) / 1000, jobId: d.job.jobId });
    }
  } catch (err) {
    post({ type: "jobError", jobId: d.job && d.job.jobId, name: d.job && d.job.name, error: String((err && err.stack) || err) });
  }
};
