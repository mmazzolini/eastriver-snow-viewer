// app.js - the interactive version of the West-East strip figure (WE_strip_final.ipynb, last cell).
// Panels: a) b) Longitudinal profile, d) e) second profile (an ICESat-2 track by default),
// c) f) ensemble distributions at a field point and at an IC2 cell, g) map with draggable profiles.
import * as core from "./core.js";

const d3 = window.d3;
const CFG = Object.assign({ data: "./data/", downloads: false, hashState: false }, window.SITE_CONFIG || {});
const urlOf = typeof CFG.url === "function" ? CFG.url : (name) => CFG.data + name;
const $ = (s) => document.querySelector(s);
const fmt2 = d3.format(".2f"), fmt0 = d3.format(".0f"), fmtPct = d3.format("+.0%");

// ------------------------------------------------------------------ state
const state = {
  year: "2024",
  exps: ["GP"],                  // in selection order: the first one is the one on the map
  band: [25, 75],
  prior: { mean: true, band: true, members: true },
  show: { members: true, aso: true, ic2: true, obs: true },
  prods: {},                     // gridded product id -> shown
  p1: null, p2: null,            // set from the year defaults; p2 lies on IC2 track p2.track
  field: { e: 326200, snap: 1000, mode: "strip" },
  ic2: null,                     // index of the IC2 cell of f)
  seg: { 1: null, 2: null },     // segments of profile 1 and 2: { a, b } in km along the profile axis
  kdeBw: "scott",
  minCells: 1,
  map: { layer: "terrain" },
};

let S = null;                    // core.Store
let Y = null;                    // year data (ASO, ok mask, defaults)
const RUNS = {};                 // run id -> run data (summary, IC2 cells)
let V = null;                    // last computed figure values
let updating = false, dirty = false, generation = 0;

const runIds = () => state.exps.map((e) => state.year.slice(2) + e);
const prodList = () => Object.values((Y && Y.prods) || {});
const shownProds = () => prodList().filter((p) => state.prods[p.id] !== false);
const dashOf = (p) => (p.dash ? { "stroke-dasharray": p.dash } : {});
const expOf = (id) => id.slice(2);
const label = (id) => (expOf(id) === "GP" ? "GPE" : "GCE");
const bandLabel = () => (state.band[0] === 25 && state.band[1] === 75 ? "IQR" : `${state.band[0]}–${state.band[1]} %`);

// ------------------------------------------------------------------ colours (theme tokens)
let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  C = { bg: v("--bg"), surface: v("--surface"), ink: v("--ink"), ink2: v("--ink-2"), muted: v("--muted"),
    grid: v("--grid"), rule: v("--rule"), GP: v("--gp"), GC: v("--gc"), ic2: v("--ic2"), rean: v("--rean"), prior: v("--prior"),
    terrain: v("--terrain"), seqLo: v("--seq-lo"), seqHi: v("--seq-hi"), divNeg: v("--div-neg"),
    divMid: v("--div-mid"), divPos: v("--div-pos"),
    dark: d3.lab(v("--surface")).l < 50 };
}
const runColor = (id) => C[expOf(id)];
const priorColor = (id) => (runIds().length > 1 ? d3.interpolateRgb(runColor(id), C.surface)(0.45) : C.prior);
const alpha = (c, a) => { const x = d3.color(c); x.opacity = a; return x.formatRgb(); };

// ------------------------------------------------------------------ status
function setStatus(msg, frac = null, error = false) {
  const el = $("#status");
  el.classList.toggle("error", error);
  el.querySelector(".msg").textContent = msg;
  el.querySelector(".bar").hidden = frac === null;
  if (frac !== null) el.querySelector(".bar i").style.width = `${Math.round(frac * 100)}%`;
}

// ------------------------------------------------------------------ panels
class Panel {
  constructor(id) {
    this.root = document.getElementById(id);
    this.plot = this.root.querySelector(".plot");
    this.title = this.root.querySelector("h3");
    this.canvas = document.createElement("canvas");
    this.svg = d3.select(this.plot).append("svg").attr("aria-hidden", "true");
    this.plot.prepend(this.canvas);
    this.w = 0; this.h = 0;
  }
  size(h) {
    const w = this.plot.clientWidth;
    this.plot.style.height = `${h}px`;
    const dpr = window.devicePixelRatio || 1;
    if (w !== this.w || h !== this.h) {
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.w = w; this.h = h;
    }
    this.ctx = this.canvas.getContext("2d");
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.svg.selectAll("*").remove();
    return { w, h };
  }
}
const P = {};

function rowHeights() {
  const fig = $("#figure");
  const wide = getComputedStyle(fig).gridTemplateAreas.includes("a g d");
  const wa = wide && P.pa ? P.pa.plot.clientWidth : Math.min(fig.clientWidth - 24, 760);
  return { merged: Math.round(Math.max(260, Math.min(470, wa * 0.72))),
    bias: Math.round(Math.max(180, Math.min(320, wa * 0.46))),
    dist: Math.round(Math.max(230, Math.min(340, wa * 0.5))) };
}

// ------------------------------------------------------------------ helpers
const finite = Number.isFinite;
function interp(x, xp, fp) {
  if (!xp.length) return NaN;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[xp.length - 1]) return fp[fp.length - 1];
  let lo = 0, hi = xp.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
  return fp[lo] + ((x - xp[lo]) * (fp[hi] - fp[lo])) / (xp[hi] - xp[lo]);
}
function nanExtent(arrs) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrs) for (const v of a) if (finite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return [lo, hi];
}
function pctile(values, p) {
  const v = Float64Array.from(values.filter(finite)).sort();
  return v.length ? core.pctSorted(v, p) : NaN;
}
function lineSvg(g, xs, ys, attrs) {
  const pts = [];
  const path = d3.line().defined((d) => finite(d[1]) && finite(d[0]));
  for (let i = 0; i < xs.length; i++) pts.push([xs[i], ys[i]]);
  const el = g.append("path").attr("d", path(pts)).attr("fill", "none");
  for (const [k, v] of Object.entries(attrs)) el.attr(k, v);
  return el;
}
function areaSvg(g, xs, y0s, y1s, fill) {
  const pts = [];
  for (let i = 0; i < xs.length; i++) pts.push([xs[i], y0s[i], y1s[i]]);
  g.append("path").attr("fill", fill).attr("stroke", "none")
    .attr("d", d3.area().defined((d) => finite(d[1]) && finite(d[2])).x((d) => d[0]).y0((d) => d[1]).y1((d) => d[2])(pts));
}
function text(g, x, y, s, attrs = {}) {
  const t = g.append("text").attr("x", x).attr("y", y).text(s)
    .attr("font-family", "var(--font-ui)").attr("font-size", 11).attr("fill", C.ink2);
  for (const [k, v] of Object.entries(attrs)) t.attr(k, v);
  return t;
}
function letter(panel, s, x) {
  text(panel.svg, x, 14, s, { "text-anchor": "end", "font-size": 14, fill: C.ink, "font-weight": 500,
    stroke: C.surface, "stroke-width": 3, "paint-order": "stroke" });
}

// ------------------------------------------------------------------ geometry from state
function stripRows() { return Array.from({ length: state.p1.nrows }, (_, i) => state.p1.row0 + i); }
function fieldRows() {
  const rows = stripRows();
  return state.field.mode === "centre" ? [rows[Math.floor((rows.length - 1) / 2)]] : rows;
}
function p2Axis() { return Math.abs(state.p2.y1 - state.p2.y0) >= Math.abs(state.p2.x1 - state.p2.x0) ? "y" : "x"; }
// columns of profile 1 whose centres lie inside segment 1 (null without a segment)
function segCols() {
  const s = state.seg[1];
  if (!s) return null;
  const clamp = (c) => Math.max(0, Math.min(S.nx - 1, c));
  const c0 = clamp(Math.ceil((s.a * 1000 - S.gx[0]) / S.dx)), c1 = clamp(Math.floor((s.b * 1000 - S.gx[0]) / S.dx));
  return [c0, Math.max(c0, c1)];
}
// IC2 cells of profile 2 inside segment 2
function seg2Cells() {
  const s = state.seg[2], ic2 = RUNS[runIds()[0]].ic2, ax = p2Axis();
  return ic2Sets().s2.filter((i) => { const c = (ax === "y" ? ic2.y[i] : ic2.x[i]) / 1000; return c >= s.a && c <= s.b; });
}
// grid cell of a point (IC2 cells lie on cell centres)
function cellAt(x, y) {
  const c = Math.round((x - S.gx[0]) / S.dx), r = Math.round((y - S.gy[0]) / S.dy);
  return r * S.nx + c;
}
// profile 2 lies on the chosen IC2 track; its extent is a Northing range
const track = () => Y.tracks[state.p2.track];
function trackRange() { const t = track(); return [t.ymin - 500, t.ymax + 500]; }
function applyTrack() { Object.assign(state.p2, core.trackLine(track(), state.p2.y0, state.p2.y1)); }

// ------------------------------------------------------------------ update pipeline
function requestUpdate() {
  if (updating) { dirty = true; return; }
  updating = true;
  requestAnimationFrame(async () => {
    try { await update(); }
    catch (err) { console.error(err); setStatus(`Could not load the data: ${err.message}. Reload the page to try again.`, null, true); }
    updating = false;
    if (dirty) { dirty = false; requestUpdate(); }
  });
}

async function update() {
  const gen = ++generation;
  const ids = runIds();
  const steps1 = core.stripSteps(S, state.p1);
  const steps2 = core.lineSteps(S, state.p2);
  const sc = segCols();
  const col = core.fieldColumn(S, Y, state.p1, state.field.e, state.field.snap);
  const fcols = sc ? d3.range(sc[0], sc[1] + 1) : [col];
  const fcells = fieldRows().flatMap((r) => fcols.map((c) => r * S.nx + c));
  const cells = [...core.stepCells(steps1), ...core.stepCells(steps2), ...fcells];
  const missing = ids.some((id) => cells.some((c) => S.mask[c] && !S.tiles.has(`${id}:${S.tileIndex(c)}`)));
  if (missing) {
    for (const k of ["pa", "pb", "pd", "pe", "pc"]) P[k].root.classList.add("dim");
    await S.ensureTiles(ids, cells, (done, n) => setStatus(n ? `Loading ensemble tiles ${done} / ${n}` : "Ready", n ? done / n : null));
    if (gen !== generation) return;
  }
  const opts = { q: state.band || [25, 75], minCells: state.minCells };
  const V1 = core.computeProfile(S, Y, ids, steps1, opts);
  const V2 = core.computeProfile(S, Y, ids, steps2, opts);
  const F = sc ? core.fieldSegment(S, Y, ids, fieldRows(), sc[0], sc[1]) : core.fieldPoint(S, Y, ids, fieldRows(), col);
  const PR1 = {}, PR2 = {};
  for (const p of prodList()) { PR1[p.id] = core.productProfile(S, Y, p.v, steps1, opts); PR2[p.id] = core.productProfile(S, Y, p.v, steps2, opts); }
  V = { ids, steps1, steps2, V1, V2, F, col, PR1, PR2 };
  for (const k of ["pa", "pb", "pd", "pe", "pc"]) P[k].root.classList.remove("dim");
  setStatus(`Ready · ${Y.date}`);
  drawAll();
}

function drawAll() {
  if (!V) return;
  readColors();
  const H = rowHeights();
  const ic = ic2Sets();
  drawMerged(P.pa, "left", V.steps1, V.V1, V.PR1, state.p1, ic.s1, "x");
  drawMerged(P.pd, "right", V.steps2, V.V2, V.PR2, state.p2, ic.s2, V.steps2.axis);
  drawBias(P.pb, "left", V.steps1, V.V1, V.PR1, state.p1, ic.s1, "x", H.bias);
  drawBias(P.pe, "right", V.steps2, V.V2, V.PR2, state.p2, ic.s2, V.steps2.axis, H.bias);
  drawDist(P.pc, "left", "field");
  drawDist(P.pf, "right", "ic2");
  drawLegends();
  drawScores();
  drawMap();
  syncInputs();
  writeHash();
}

// IC2 cells of the two profiles (indices into the year's IC2 arrays; the same cells in every run)
function ic2Sets() {
  const ic2 = RUNS[runIds()[0]].ic2;
  return { s1: core.ic2InStrip(S, ic2, state.p1, Y.hasAso), s2: core.ic2NearLine(ic2, state.p2, state.p2.cap, Y.hasAso) };
}

// ------------------------------------------------------------------ a) d) terrain + snow
function drawMerged(panel, side, steps, Vp, PR, geo, icSet, axis) {
  const H = rowHeights();
  const { w, h } = panel.size(H.merged);
  const m = side === "left" ? { l: 56, r: 62, t: 20, b: 8 } : { l: 62, r: 56, t: 20, b: 8 };
  const ids = V.ids, K = geo.k, coord = steps.coord, z = Vp.z;
  const okI = []; for (let i = 0; i < z.length; i++) if (finite(z[i])) okI.push(i);
  const isP1 = panel === P.pa;
  panel.title.textContent = isP1
    ? `Longitudinal profile at N ${fmt2(S.gy[geo.row0 + (geo.nrows - 1) / 2 | 0] / 1000)} km, width ${geo.nrows * 50} m`
    : `ICESat-2 profile on track ${geo.track + 1} (±${fmt0(geo.hw)} m corridor)`;
  if (!okI.length) { text(panel.svg, w / 2, h / 2, "No cells with model values and ASO here", { "text-anchor": "middle" }); return; }
  const xlim = xLimits(panel, steps, okI);
  const x = d3.scaleLinear().domain(xlim).range([m.l, w - m.r]);
  const zBar = side === "left" ? z[okI[okI.length - 1]] : z[okI[0]];
  const zEnd = side === "left" ? z[okI[0]] : z[okI[okI.length - 1]];
  const bar = [1, 2, 3];
  const tops = [zBar + K * 3];
  for (const id of ids) {
    const R = Vp.runs[id];
    for (let i = 0; i < z.length; i++) {
      if (state.band) tops.push(z[i] + K * R.hi[i]);
      tops.push(z[i] + K * R.mean[i]);
      if (state.prior.band && state.band) tops.push(z[i] + K * R.phi[i]);
      if (state.show.aso) tops.push(z[i] + K * Vp.aso[i]);
    }
  }
  for (const p of shownProds()) PR[p.id].vals.forEach((v, i) => tops.push(z[i] + K * v));
  const zmin = d3.min(z.filter(finite));
  const top = d3.max(tops.filter(finite));
  const ymin = zmin - 0.06 * (top - zmin), ymax = top + 0.05 * (top - ymin);
  const y = d3.scaleLinear().domain([ymin, ymax]).range([h - m.b, m.t]);
  const g = panel.svg.append("g");
  // grid: one line per metre of snow, aligned with the scale bar
  for (let k = Math.floor((ymin - zBar) / K); k <= Math.ceil((ymax - zBar) / K); k++) {
    const yy = zBar + k * K;
    if (yy > ymin && yy < ymax) g.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(yy)).attr("y2", y(yy)).attr("stroke", C.grid).attr("stroke-width", 1);
  }
  const X = Array.from(coord, (c) => x(c));
  const Y0 = Array.from(z, () => y(ymin)), Z = Array.from(z, (v) => (finite(v) ? y(v) : NaN));
  areaSvg(g, X, Y0, Z, C.surface);
  areaSvg(g, X, Y0, Z, alpha(C.terrain, 0.25));
  const at = (arr) => Array.from(arr, (v, i) => (finite(v) && finite(z[i]) ? y(z[i] + K * v) : NaN));
  for (const id of ids) {
    const R = Vp.runs[id];
    if (state.band) areaSvg(g, X, at(R.lo), at(R.hi), alpha(runColor(id), ids.length > 1 ? 0.2 : 0.25));
    if (state.band && state.prior.band) areaSvg(g, X, at(R.plo), at(R.phi), alpha(priorColor(id), ids.length > 1 ? 0.18 : 0.2));
  }
  lineSvg(g, X, Z, { stroke: C.terrain, "stroke-width": 1.2 });
  for (const id of ids) if (state.prior.mean) lineSvg(g, X, at(Vp.runs[id].prior), { stroke: priorColor(id), "stroke-width": 1.2, "stroke-dasharray": "5 3" });
  if (state.show.aso) lineSvg(g, X, at(Vp.aso), { stroke: C.ink, "stroke-width": 1.8 });
  for (const p of shownProds()) lineSvg(g, X, at(PR[p.id].vals), { stroke: C.rean, "stroke-width": 1.4, ...dashOf(p) });
  for (const id of ids) lineSvg(g, X, at(Vp.runs[id].mean), { stroke: runColor(id), "stroke-width": 1.4 });
  // IC2 cells, drawn from the terrain line
  if (state.show.ic2) {
    const zc = okI.map((i) => z[i]), cc = okI.map((i) => coord[i]);
    ids.forEach((id, j) => {
      const ic2 = RUNS[id].ic2;
      const off = ids.length > 1 ? (j - 0.5) * 0.06 : 0;
      for (const i of icSet) {
        const c = (axis === "x" ? ic2.x[i] : ic2.y[i]) / 1000;
        const zi = interp(c, cc, zc);
        const e = Float64Array.from(ic2.post[i]).sort();
        const q = state.band || [25, 75];
        const cx = x(c + off);
        g.append("line").attr("x1", cx).attr("x2", cx).attr("y1", y(zi + K * core.pctSorted(e, q[0]))).attr("y2", y(zi + K * core.pctSorted(e, q[1])))
          .attr("stroke", C.ic2).attr("stroke-width", 1);
        marker(g, expOf(id), cx, y(zi + K * core.mean(e)), 3.6, C.ic2);
      }
    });
  }
  pointMarks(g, x, y(ymax), y(ymin), axis, isP1);
  // elevation axis on the outer side, up to the terrain at the outer end
  const ticks = y.ticks(6).filter((t) => t >= ymin && t <= zEnd);
  const ax = side === "left" ? d3.axisLeft(y) : d3.axisRight(y);
  const ga = panel.svg.append("g").attr("transform", `translate(${side === "left" ? m.l : w - m.r},0)`)
    .call(ax.tickValues(ticks).tickSize(4).tickFormat(d3.format("d")));
  styleAxis(ga);
  ga.select(".domain").attr("d", `M0,${y(ymin)}V${y(zEnd)}`);
  text(panel.svg, 0, 0, "Elevation (m a.s.l.)", { transform: `translate(${side === "left" ? 13 : w - 13},${(y(ymin) + y(zEnd)) / 2}) rotate(-90)`, "text-anchor": "middle" });
  // snow-depth scale bar on the inner side, from the terrain at the inner end
  const xb = side === "left" ? w - m.r + 8 : m.l - 8, sg = side === "left" ? 1 : -1;
  panel.svg.append("line").attr("x1", xb).attr("x2", xb).attr("y1", y(zBar)).attr("y2", y(zBar + K * 3)).attr("stroke", C.ink2).attr("stroke-width", 2.5);
  for (const v of [0, ...bar]) {
    panel.svg.append("line").attr("x1", xb).attr("x2", xb + sg * 5).attr("y1", y(zBar + v * K)).attr("y2", y(zBar + v * K)).attr("stroke", C.ink2).attr("stroke-width", 1.2);
    text(panel.svg, xb + sg * 8, y(zBar + v * K) + 4, v ? `${v} m` : "0", { "text-anchor": side === "left" ? "start" : "end", "font-family": "var(--font-data)" });
  }
  letter(panel, isP1 ? "a)" : "d)", w - m.r - 4);
  hoverLayer(panel, x, m, h, steps, Vp, PR, axis, "merged");
}

function marker(g, exp, cx, cy, r, color) {
  if (exp === "GC") g.append("rect").attr("x", cx - r).attr("y", cy - r).attr("width", 2 * r).attr("height", 2 * r).attr("fill", color).attr("stroke", C.surface).attr("stroke-width", 1.2);
  else g.append("circle").attr("cx", cx).attr("cy", cy).attr("r", r).attr("fill", color).attr("stroke", C.surface).attr("stroke-width", 1.2);
}

function xLimits(panel, steps, okI) {
  if (panel === P.pa || panel === P.pb) {
    const c = okI.map((i) => steps.coord[i]);
    return [d3.min(c) - 0.3, d3.max(c) + 0.3];
  }
  const L = state.p2, ax = steps.axis;
  const a = (ax === "y" ? [L.y0, L.y1] : [L.x0, L.x1]).map((v) => v / 1000);
  return [Math.min(...a), Math.max(...a)];
}

// vertical dashed lines at the two points (field point: Easting; IC2 cell: its coordinate), or at the
// two ends of a segment (profile 1 in a) b), profile 2 in d) e))
function pointMarks(g, x, y0, y1, axis, isP1) {
  const ic2 = RUNS[runIds()[0]].ic2;
  const [d0, d1] = x.domain();
  const vline = (c, color, wdt = 1) => {
    if (c < d0 || c > d1) return;
    g.append("line").attr("x1", x(c)).attr("x2", x(c)).attr("y1", y0).attr("y2", y1).attr("stroke", color).attr("stroke-width", wdt).attr("stroke-dasharray", "4 3");
  };
  if (state.seg[1]) { if (isP1) for (const c of [state.seg[1].a, state.seg[1].b]) vline(c, C.ink2, 1.3); }
  else if (V.F) vline(isP1 || axis === "x" ? V.F.x / 1000 : S.gy[fieldRows()[0]] / 1000, C.ink2);
  if (state.seg[2]) { if (!isP1) for (const c of [state.seg[2].a, state.seg[2].b]) vline(c, C.ic2, 1.3); }
  else if (state.ic2 !== null) vline((isP1 || axis === "x" ? ic2.x[state.ic2] : ic2.y[state.ic2]) / 1000, C.ic2);
}

function styleAxis(ga) {
  ga.selectAll("text").attr("fill", C.ink2).attr("font-family", "var(--font-data)").attr("font-size", 10.5);
  ga.selectAll("line").attr("stroke", C.muted);
  ga.select(".domain").attr("stroke", C.muted);
}

// ------------------------------------------------------------------ b) e) model - ASO
function drawBias(panel, side, steps, Vp, PR, geo, icSet, axis, hgt) {
  const { w, h } = panel.size(hgt);
  if (!Y.hasAso) {
    text(panel.svg, w / 2, h / 2, "ASO snow depth is not part of this data record, so the comparison is not shown.", { "text-anchor": "middle" });
    return;
  }
  const m = side === "left" ? { l: 56, r: 62, t: 6, b: 36 } : { l: 62, r: 56, t: 6, b: 36 };
  const ids = V.ids, M = S.nmem, coord = steps.coord, ns = coord.length;
  const okI = []; for (let i = 0; i < ns; i++) if (finite(Vp.z[i])) okI.push(i);
  if (!okI.length) return;
  const x = d3.scaleLinear().domain(xLimits(panel, steps, okI)).range([m.l, w - m.r]);
  let lim = geo.bias;
  if (!(lim > 0)) {
    const vals = [];
    for (const id of ids) for (const v of Vp.runs[id].memb) if (finite(v)) vals.push(Math.abs(v));
    lim = (pctile(vals, 99.5) || 1) * (geo.biasFac || 1);
  }
  const y = d3.scaleLinear().domain([-lim, lim]).range([h - m.b, m.t]);
  const ctx = panel.ctx;
  ctx.save(); ctx.beginPath(); ctx.rect(m.l, m.t, w - m.l - m.r, h - m.t - m.b); ctx.clip();
  const memberLines = (arr, color, a) => {
    ctx.strokeStyle = alpha(color, a); ctx.lineWidth = 0.6;
    for (let k = 0; k < M; k++) {
      ctx.beginPath(); let pen = false;
      for (let i = 0; i < ns; i++) {
        const v = arr[i * M + k];
        if (!finite(v)) { pen = false; continue; }
        const px = x(coord[i]), py = y(v);
        if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
      }
      ctx.stroke();
    }
  };
  const ma = ids.length > 1 ? 0.12 : 0.22;   // lighter when two experiments overlap
  for (const id of ids) if (state.prior.members) memberLines(Vp.runs[id].pmemb, priorColor(id), ma);
  for (const id of ids) if (state.show.members) memberLines(Vp.runs[id].memb, runColor(id), ma);
  // IC2 members
  if (state.show.ic2) {
    ctx.fillStyle = alpha(C.ic2, 0.25);
    for (const id of ids) {
      const ic2 = RUNS[id].ic2;
      for (const i of icSet) {
        const c = (axis === "x" ? ic2.x[i] : ic2.y[i]) / 1000;
        for (const v of ic2.post[i]) ctx.fillRect(x(c) - 1, y(v - ic2.aso[i]) - 1, 2, 2);
      }
    }
  }
  ctx.restore();
  const clipId = `clip-${panel.root.id}`;
  panel.svg.append("defs").append("clipPath").attr("id", clipId).append("rect").attr("x", m.l).attr("y", m.t).attr("width", Math.max(0, w - m.l - m.r)).attr("height", Math.max(0, h - m.t - m.b));
  const g = panel.svg.append("g").attr("clip-path", `url(#${clipId})`);
  g.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", C.ink).attr("stroke-width", 0.8);
  const X = Array.from(coord, (c) => x(c));
  for (const id of ids) {
    const R = Vp.runs[id];
    if (state.prior.mean) lineSvg(g, X, Array.from(R.prior, (v, i) => y(v - Vp.aso[i])), { stroke: priorColor(id), "stroke-width": 1.3, "stroke-dasharray": "5 3" });
    lineSvg(g, X, Array.from(R.mean, (v, i) => y(v - Vp.aso[i])), { stroke: runColor(id), "stroke-width": 2 });
  }
  for (const p of shownProds()) lineSvg(g, X, Array.from(PR[p.id].vals, (v, i) => y(v - Vp.aso[i])), { stroke: C.rean, "stroke-width": 1.4, ...dashOf(p) });
  if (state.show.ic2) {
    ids.forEach((id) => {
      const ic2 = RUNS[id].ic2;
      for (const i of icSet) {
        const c = (axis === "x" ? ic2.x[i] : ic2.y[i]) / 1000;
        const e = core.mean(ic2.post[i]) - ic2.aso[i];
        if (Math.abs(e) <= lim) marker(g, expOf(id), x(c), y(e), 3.4, C.ic2);
      }
    });
  }
  pointMarks(g, x, m.t, h - m.b, axis, panel === P.pb);
  const ax = side === "left" ? d3.axisLeft(y) : d3.axisRight(y);
  styleAxis(panel.svg.append("g").attr("transform", `translate(${side === "left" ? m.l : w - m.r},0)`).call(ax.ticks(5).tickSize(4)));
  styleAxis(panel.svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.round((w - m.l - m.r) / 70))).tickFormat(d3.format("~f")).tickSize(4)));
  text(panel.svg, 0, 0, "Model − ASO (m)", { transform: `translate(${side === "left" ? 13 : w - 13},${(m.t + h - m.b) / 2}) rotate(-90)`, "text-anchor": "middle" });
  const xl = panel === P.pb ? "Easting (km)" : axis === "y" ? "Northing along the profile (km)" : "Easting along the profile (km)";
  text(panel.svg, (m.l + w - m.r) / 2, h - 4, xl, { "text-anchor": "middle" });
  letter(panel, panel === P.pb ? "b)" : "e)", w - m.r - 4);
  hoverLayer(panel, x, m, h, steps, Vp, PR, axis, "bias");
}

// ------------------------------------------------------------------ hover readout and clicks
function hoverLayer(panel, x, m, h, steps, Vp, PR, axis, kind) {
  const isP1 = panel === P.pa || panel === P.pb, side = isP1 ? 1 : 2;
  const partner = isP1 ? (panel === P.pa ? P.pb : P.pa) : (panel === P.pd ? P.pe : P.pd);
  const rect = panel.svg.append("rect").attr("class", "hit").attr("x", m.l).attr("y", 0).attr("width", Math.max(0, x.range()[1] - m.l)).attr("height", h)
    .attr("fill", "transparent").style("cursor", "crosshair");
  const tip = $("#tooltip");
  const nearest = (px) => {
    const c = x.invert(px);
    let best = -1, bd = Infinity;
    for (let i = 0; i < steps.coord.length; i++) { const d = Math.abs(steps.coord[i] - c); if (d < bd && finite(Vp.z[i])) { bd = d; best = i; } }
    return best;
  };
  const show = (ev) => {
    const [px] = d3.pointer(ev, panel.svg.node());
    const i = nearest(px);
    for (const p of [panel, partner]) {
      p.svg.selectAll(".xhair").remove();
      if (i >= 0) p.svg.append("line").attr("class", "xhair").attr("x1", x(steps.coord[i])).attr("x2", x(steps.coord[i])).attr("y1", 0).attr("y2", p.h)
        .attr("stroke", C.muted).attr("stroke-width", 1).attr("pointer-events", "none");
    }
    if (i < 0) { tip.hidden = true; return; }
    tip.replaceChildren();
    const head = document.createElement("div"); head.className = "t";
    head.textContent = `${axis === "x" ? "E" : "N"} ${fmt2(steps.coord[i])} km · ${fmt0(Vp.z[i])} m · ${Vp.n[i]} cell${Vp.n[i] > 1 ? "s" : ""}`;
    tip.append(head);
    const row = (color, name, value, dash) => {
      const r = document.createElement("div"); r.className = "r";
      const k = document.createElement("i"); k.style.background = dash ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 6px)` : color;
      const n = document.createElement("span"); n.textContent = name;
      const b = document.createElement("b"); b.textContent = value;
      r.append(k, n, b); tip.append(r);
    };
    if (kind === "merged") {
      if (state.show.aso) row(C.ink, "ASO", `${fmt2(Vp.aso[i])} m`);
      for (const id of V.ids) {
        const R = Vp.runs[id];
        row(runColor(id), `${label(id)} post.${state.band ? ` (${bandLabel()})` : ""}`, `${fmt2(R.mean[i])}${state.band ? ` (${fmt2(R.lo[i])}–${fmt2(R.hi[i])})` : ""} m`);
        if (state.prior.mean) row(priorColor(id), `${label(id)} prior`, `${fmt2(R.prior[i])} m`, true);
      }
      for (const p of shownProds()) row(C.rean, p.label, `${fmt2(PR[p.id].vals[i])} m`, !!p.dash);
    } else {
      for (const id of V.ids) {
        const R = Vp.runs[id];
        row(runColor(id), `${label(id)} post. − ASO`, `${fmt2(R.mean[i] - Vp.aso[i])} m`);
        if (state.prior.mean) row(priorColor(id), `${label(id)} prior − ASO`, `${fmt2(R.prior[i] - Vp.aso[i])} m`, true);
      }
      for (const p of shownProds()) row(C.rean, `${p.label} − ASO`, `${fmt2(PR[p.id].vals[i] - Vp.aso[i])} m`, !!p.dash);
    }
    tip.hidden = false;
    const bx = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${bx}px`; tip.style.top = `${Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8)}px`;
  };
  // click = point, drag across = segment (two dashed lines while dragging)
  const pxOf = (ev) => d3.pointer(ev, panel.svg.node())[0];
  const brush = (a, b) => {
    for (const p of [panel, partner]) {
      p.svg.selectAll(".brush").remove();
      if (a === null) continue;
      for (const v of [a, b]) p.svg.append("line").attr("class", "brush").attr("x1", v).attr("x2", v).attr("y1", 0).attr("y2", p.h)
        .attr("stroke", isP1 ? C.ink2 : C.ic2).attr("stroke-width", 1.3).attr("stroke-dasharray", "4 3").attr("pointer-events", "none");
    }
  };
  let down = null;
  rect.on("pointerdown", (ev) => {
    if (ev.button) return;
    down = { px: pxOf(ev), moved: false };
    if (rect.node().setPointerCapture) rect.node().setPointerCapture(ev.pointerId);
  }).on("pointermove", (ev) => {
    if (down) { const px = pxOf(ev); if (Math.abs(px - down.px) > 5) { down.moved = true; brush(down.px, px); } }
    show(ev);
  }).on("pointerup", (ev) => {
    if (!down) return;
    const d = down, px = pxOf(ev);
    down = null; brush(null);
    const lo = Math.max(m.l, Math.min(d.px, px)), hi = Math.min(x.range()[1], Math.max(d.px, px));
    if (d.moved && hi - lo > 5) setSegment(side, x.invert(lo), x.invert(hi));
    else pickPoint(side, x.invert(px) * 1000, axis);
  }).on("pointercancel", () => { down = null; brush(null); })
    .on("pointerleave", () => {
      if (down) return;
      tip.hidden = true;
      for (const p of [panel, partner]) p.svg.selectAll(".xhair").remove();
    });
}
function setSegment(side, a, b) {
  state.seg[side] = { a, b };
  if (side === 2 && !seg2Cells().length) { state.seg[2] = null; flash("No IC2 cells between these two lines."); drawAll(); return; }
  if (side === 1) requestUpdate(); else drawAll();
}
function pickPoint(side, c, axis) {
  state.seg[side] = null;
  if (side === 1) { state.field.e = c; requestUpdate(); return; }
  const ic2 = RUNS[runIds()[0]].ic2, set = ic2Sets().s2;
  if (set.length) {
    const pos = (i) => (axis === "x" ? ic2.x[i] : ic2.y[i]);
    state.ic2 = set.reduce((b, i) => (Math.abs(pos(i) - c) < Math.abs(pos(b) - c) ? i : b), set[0]);
  }
  drawAll();
}

// ------------------------------------------------------------------ c) f) distributions
function drawDist(panel, side, which) {
  const H = rowHeights();
  const { w, h } = panel.size(H.dist);
  const m = side === "left" ? { l: 52, r: 12, t: 8, b: 38 } : { l: 12, r: 52, t: 8, b: 38 };
  const ids = V.ids;
  let sets = [], aso = NaN, info = [], obs = null, pcells = [], seg = null;
  if (which === "field") {
    seg = state.seg[1];
    panel.title.textContent = seg ? "Segment ensemble distribution" : "Cell ensemble distribution";
    if (!V.F) { text(panel.svg, w / 2, h / 2, seg ? "No cell with model values and ASO in this segment" : "No cell with model values and ASO at this point", { "text-anchor": "middle" }); return; }
    sets = ids.map((id) => ({ id, post: V.F.runs[id].post, prior: V.F.runs[id].prior }));
    aso = V.F.aso;
    pcells = V.F.cells;
    const rows = fieldRows();
    const nr = rows.length > 1 ? `${fmt2((S.gy[rows[0]] - 25) / 1000)}–${fmt2((S.gy[rows[rows.length - 1]] + 25) / 1000)}` : fmt2(S.gy[rows[0]] / 1000);
    info.push(seg ? `Segment E ${fmt2(V.F.x / 1000)}–${fmt2(V.F.x1 / 1000)} km · ${V.F.cells.length} cells · ${fmt0(V.F.z)} m`
      : `E ${fmt2(V.F.x / 1000)} km, N ${nr} km, ${fmt0(V.F.z)} m`);
  } else {
    seg = state.seg[2];
    panel.title.textContent = seg ? "IC2 segment ensemble distribution" : "IC2 cell ensemble distribution";
    const ic2 = RUNS[ids[0]].ic2;
    if (seg) {
      const idx = seg2Cells();
      if (!idx.length) { text(panel.svg, w / 2, h / 2, "No IC2 cells in this segment", { "text-anchor": "middle" }); return; }
      const G = ids.map((id) => core.ic2Segment(RUNS[id].ic2, idx));
      sets = ids.map((id, j) => ({ id, post: G[j].post, prior: G[j].prior }));
      aso = G[0].aso;
      obs = { v: G[0].obs, r: G[0].r };
      pcells = idx.map((i) => cellAt(ic2.x[i], ic2.y[i]));
      info.push(`Segment ${p2Axis() === "y" ? "N" : "E"} ${fmt2(seg.a)}–${fmt2(seg.b)} km · ${idx.length} IC2 cells`);
    } else {
      const i = state.ic2;
      if (i === null) return;
      sets = ids.map((id) => ({ id, post: RUNS[id].ic2.post[i], prior: RUNS[id].ic2.prior[i] }));
      aso = ic2.aso[i];
      obs = { v: ic2.obs[i], r: ic2.r[i] };
      pcells = [cellAt(ic2.x[i], ic2.y[i])];
      info.push(`IC2 cell ${i}: E ${fmt2(ic2.x[i] / 1000)}, N ${fmt2(ic2.y[i] / 1000)} km, ${fmt0(ic2.z[i])} m`);
    }
  }
  for (const s of sets) {
    info.push(`${label(s.id)} post. ${fmt2(core.mean(s.post))} ± ${fmt2(core.std(s.post))} m` +
      (state.prior.mean || state.prior.band ? ` · prior ${fmt2(core.mean(s.prior))} ± ${fmt2(core.std(s.prior))}` : ""));
  }
  if (obs && state.show.obs) info.push(`IC2 obs.${seg ? " mean" : ""} ${fmt2(obs.v)} m (σ ${fmt2(Math.sqrt(obs.r))})`);
  if (state.show.aso && finite(aso)) info.push(`ASO ${fmt2(aso)} m`);
  const pv = shownProds().map((p) => ({ p, v: core.meanOver(p.v, pcells) })).filter((d) => finite(d.v));
  for (const d of pv) info.push(`${d.p.label} ${fmt2(d.v)} m`);
  const showPrior = state.prior.mean || state.prior.band;
  const all = sets.flatMap((s) => [...s.post, ...(showPrior ? s.prior : [])]);
  let hi = d3.max(all);
  if (finite(aso)) hi = Math.max(hi, aso);
  for (const d of pv) hi = Math.max(hi, d.v);
  if (obs && state.show.obs) hi = Math.max(hi, obs.v + 2 * Math.sqrt(obs.r));
  const lo = Math.min(-0.05, d3.min(all));
  const grid = d3.range(0, 400).map((k) => lo + ((hi * 1.08 - lo) * k) / 399);
  const bw = isNaN(+state.kdeBw) ? state.kdeBw : +state.kdeBw;
  const dens = sets.map((s) => ({ id: s.id, post: core.kde(s.post, grid, { bw }), prior: showPrior ? core.kde(s.prior, grid, { bw }) : null }));
  const like = obs && state.show.obs ? grid.map((g) => Math.exp(-0.5 * (g - obs.v) ** 2 / obs.r) / Math.sqrt(2 * Math.PI * obs.r)) : null;
  let dmax = d3.max(dens.flatMap((d) => [...d.post, ...(d.prior || [])]));
  if (like) dmax = Math.max(dmax, d3.max(like));
  dmax = dmax || 1;
  const nr = sets.length * (showPrior ? 2 : 1);
  const wr = 0.11 * dmax;
  const xr = [-(nr + 0.2) * wr, dmax * 1.05];
  const x = d3.scaleLinear().domain(xr).range(side === "left" ? [m.l, w - m.r] : [w - m.r, m.l]);
  const y = d3.scaleLinear().domain([lo, hi * 1.08]).range([h - m.b, m.t]);
  const g = panel.svg.append("g");
  g.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", h - m.b).attr("stroke", C.muted).attr("stroke-width", 0.6);
  const curve = (dv) => grid.map((gv, k) => [x(dv[k]), y(gv)]);
  dens.forEach((d, j) => {
    const col = runColor(d.id);
    g.append("path").attr("d", d3.area().x0(x(0)).x1((p) => p[0]).y((p) => p[1])(curve(d.post))).attr("fill", alpha(col, sets.length > 1 ? 0.18 : 0.25));
    g.append("path").attr("d", d3.line()(curve(d.post))).attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.6);
    if (d.prior) g.append("path").attr("d", d3.line()(curve(d.prior))).attr("fill", "none").attr("stroke", priorColor(d.id)).attr("stroke-width", 1.3).attr("stroke-dasharray", "5 3");
    // rugs: one column per run (posterior), then the priors
    const s = sets[j];
    const rug = (vals, k, color) => {
      for (const v of vals) g.append("line").attr("x1", x(-(k + 1) * wr + 0.08 * wr)).attr("x2", x(-k * wr - 0.08 * wr)).attr("y1", y(v)).attr("y2", y(v)).attr("stroke", alpha(color, 0.6)).attr("stroke-width", 0.8);
    };
    rug(s.post, j, col);
    if (showPrior) rug(s.prior, sets.length + j, priorColor(d.id));
    g.append("line").attr("x1", x(-(j + 1) * wr)).attr("x2", x(0.35 * dmax)).attr("y1", y(core.mean(s.post))).attr("y2", y(core.mean(s.post))).attr("stroke", col).attr("stroke-width", 2.2);
    if (state.prior.mean) g.append("line").attr("x1", x(-(sets.length + j + 1) * wr)).attr("x2", x(0.35 * dmax)).attr("y1", y(core.mean(s.prior))).attr("y2", y(core.mean(s.prior)))
      .attr("stroke", priorColor(d.id)).attr("stroke-width", 2).attr("stroke-dasharray", "5 3");
  });
  if (like) {
    g.append("path").attr("d", d3.line()(grid.map((gv, k) => [x(like[k]), y(gv)]))).attr("fill", "none").attr("stroke", C.ic2).attr("stroke-width", 1.3).attr("stroke-dasharray", "1.5 2.5");
    g.append("line").attr("x1", x(xr[0])).attr("x2", x(xr[1])).attr("y1", y(obs.v)).attr("y2", y(obs.v)).attr("stroke", C.ic2).attr("stroke-width", 1.2).attr("stroke-dasharray", "7 3 1.5 3");
  }
  for (const d of pv) {
    const l = g.append("line").attr("x1", x(xr[0])).attr("x2", x(xr[1])).attr("y1", y(d.v)).attr("y2", y(d.v)).attr("stroke", C.rean).attr("stroke-width", 1.4);
    if (d.p.dash) l.attr("stroke-dasharray", d.p.dash);
  }
  if (state.show.aso && finite(aso)) g.append("line").attr("x1", x(xr[0])).attr("x2", x(xr[1])).attr("y1", y(aso)).attr("y2", y(aso)).attr("stroke", C.ink).attr("stroke-width", 1.8);
  const ay = side === "left" ? d3.axisLeft(y) : d3.axisRight(y);
  styleAxis(panel.svg.append("g").attr("transform", `translate(${side === "left" ? m.l : w - m.r},0)`).call(ay.ticks(6).tickSize(4)));
  styleAxis(panel.svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).ticks(5).tickSize(4)));
  text(panel.svg, 0, 0, "Snow depth (m)", { transform: `translate(${side === "left" ? 13 : w - 13},${(m.t + h - m.b) / 2}) rotate(-90)`, "text-anchor": "middle" });
  text(panel.svg, (m.l + w - m.r) / 2, h - 4, "Probability density (1/m)", { "text-anchor": "middle" });
  // numbers box
  const bx = side === "left" ? w - m.r - 6 : m.l + 6;
  const tg = panel.svg.append("g");
  info.forEach((s, k) => text(tg, bx, m.t + 30 + 14 * k, s, { "text-anchor": side === "left" ? "end" : "start", "font-size": 10.5,
    stroke: C.surface, "stroke-width": 3, "paint-order": "stroke" }));
  letter(panel, which === "field" ? "c)" : "f)", side === "left" ? w - m.r - 4 : w - m.r - 4);
}

// ------------------------------------------------------------------ legends
function legendRow(box, draw, label) {
  const row = document.createElement("div"); row.className = "row";
  const svg = d3.select(row).append("svg").attr("viewBox", "0 0 26 12");
  draw(svg);
  const t = document.createElement("span"); t.textContent = label;
  row.append(t); box.append(row);
}
const L = {
  line: (c, wdt = 2, dash = null) => (s) => { const l = s.append("line").attr("x1", 1).attr("x2", 25).attr("y1", 6).attr("y2", 6).attr("stroke", c).attr("stroke-width", wdt); if (dash) l.attr("stroke-dasharray", dash); },
  band: (c) => (s) => s.append("rect").attr("x", 1).attr("y", 1).attr("width", 24).attr("height", 10).attr("rx", 2).attr("fill", c),
  ic2: (exp) => (s) => { s.append("line").attr("x1", 13).attr("x2", 13).attr("y1", 0).attr("y2", 12).attr("stroke", C.ic2); marker(s, exp, 13, 6, 3.4, C.ic2); },
  dot: (c, a = 1) => (s) => s.append("circle").attr("cx", 13).attr("cy", 6).attr("r", 2.4).attr("fill", alpha(c, a)),
};
function drawLegends() {
  const ids = V.ids, box = $("#legend");
  box.replaceChildren();
  const grp = (cap) => {
    const g = document.createElement("div"); g.className = "grp";
    const c = document.createElement("span"); c.className = "cap"; c.textContent = cap;
    g.append(c); box.append(g);
    return g;
  };
  const top = grp("a) d) profiles");
  for (const id of ids) {
    if (state.band) legendRow(top, L.band(alpha(runColor(id), 0.25)), `${label(id)} post. ${bandLabel()}`);
    if (state.band && state.prior.band) legendRow(top, L.band(alpha(priorColor(id), 0.25)), `${label(id)} prior ${bandLabel()}`);
  }
  legendRow(top, L.line(C.terrain, 1.4), "Elevation profile");
  for (const id of ids) if (state.prior.mean) legendRow(top, L.line(priorColor(id), 1.4, "5 3"), `${label(id)} prior mean`);
  if (state.show.aso) legendRow(top, L.line(C.ink, 2), "ASO");
  for (const id of ids) legendRow(top, L.line(runColor(id), 1.6), `${label(id)} post. mean`);
  if (state.show.ic2) for (const id of ids) legendRow(top, L.ic2(expOf(id)), `IC2 cells: ${label(id)} post.${state.band ? `, ${bandLabel()}` : ""}`);
  const bot = grp("b) e) model − ASO");
  for (const id of ids) legendRow(bot, L.line(runColor(id), 2), `${label(id)} ensemble mean`);
  if (state.prior.mean) for (const id of ids) legendRow(bot, L.line(priorColor(id), 1.3, "5 3"), `${label(id)} prior mean`);
  if (state.show.members) legendRow(bot, L.line(alpha(runColor(ids[0]), 0.5), 0.8), "posterior members");
  if (state.prior.members) legendRow(bot, L.line(alpha(priorColor(ids[0]), 0.6), 0.8), "prior members");
  if (state.show.ic2) legendRow(bot, L.dot(C.ic2, 0.7), "IC2 cells (members and mean)");
  const dist = grp("c) f) distributions");
  for (const id of ids) legendRow(dist, L.band(alpha(runColor(id), 0.3)), `${label(id)} posterior`);
  if (state.prior.mean || state.prior.band) for (const id of ids) legendRow(dist, L.line(priorColor(id), 1.3, "5 3"), `${label(id)} prior`);
  if (state.show.obs) { legendRow(dist, L.line(C.ic2, 1.2, "7 3 1.5 3"), "IC2 observation"); legendRow(dist, L.line(C.ic2, 1.3, "1.5 2.5"), "IC2 likelihood N(obs, R)"); }
  if (state.show.aso) legendRow(dist, L.line(C.ink, 1.8), "ASO");
  legendRow(dist, L.line(C.ink2, 2.2), "ensemble mean");
  legendRow(dist, L.line(alpha(C.ink2, 0.6), 0.8), "members (ticks)");
  legendRow(dist, L.line(C.ink2, 1.2, "4 3"), "point or segment ends (a, b, d, e)");
  if (shownProds().length) {
    const pg = grp("gridded products");
    for (const p of shownProds()) legendRow(pg, L.line(C.rean, 1.6, p.dash), `${p.label} (${p.res})`);
  }
}

// ------------------------------------------------------------------ scores
function drawScores() {
  const t = $("#scores"); t.replaceChildren();
  const head = t.createTHead().insertRow();
  for (const s of ["Profile", "Experiment", "Cells", "Bias (m)", "RMSE (m)", "CRPS (m)", "CRPS skill"]) {
    const th = document.createElement("th"); th.textContent = s; head.append(th);
  }
  const body = t.createTBody();
  const arrow = (a, b) => `${fmt2(a)} → ${fmt2(b)}`;
  const cells = (r, vals) => { for (const v of vals) { const c = r.insertCell(); c.className = "num"; c.textContent = v; } };
  for (const [name, Vp, PR] of [["Longitudinal", V.V1, V.PR1], [ic2Sets().s2.length ? "ICESat-2" : "Profile 2", V.V2, V.PR2]]) {
    for (const id of V.ids) {
      const sc = Vp.runs[id].score, r = body.insertRow();
      const c0 = r.insertCell(); c0.textContent = name;
      const c1 = r.insertCell(); const k = document.createElement("span"); k.className = "runkey"; k.style.background = runColor(id);
      c1.append(k, document.createTextNode(label(id)));
      cells(r, sc.n && finite(sc.crpsPost) ? [String(sc.n), arrow(sc.biasPrior, sc.biasPost), arrow(sc.rmsePrior, sc.rmsePost), arrow(sc.crpsPrior, sc.crpsPost), fmtPct(sc.skill)] : [String(sc.n), "–", "–", "–", "–"]);
    }
    for (const p of shownProds()) {
      const sc = PR[p.id].score, r = body.insertRow();
      const c0 = r.insertCell(); c0.textContent = name;
      const c1 = r.insertCell(); const k = document.createElement("span"); k.className = "runkey";
      k.style.background = p.dash ? `repeating-linear-gradient(90deg, ${C.rean} 0 3px, transparent 3px 5px)` : C.rean;
      c1.append(k, document.createTextNode(p.label));
      cells(r, sc.n ? [String(sc.n), fmt2(sc.bias), fmt2(sc.rmse), fmt2(sc.mae), "–"] : [String(sc.n), "–", "–", "–", "–"]);
    }
  }
}

// ------------------------------------------------------------------ map
const map = { W: 0, H: 0, t: d3.zoomIdentity, img: null, imgKey: "", hs: null };
const ext = () => ({ x0: S.gx[0] - 25, x1: S.gx[S.nx - 1] + 25, y0: S.gy[0] - 25, y1: S.gy[S.ny - 1] + 25 });
function baseScale() {
  const e = ext(), s = Math.min(map.W / (e.x1 - e.x0), map.H / (e.y1 - e.y0));
  return { s, ox: (map.W - s * (e.x1 - e.x0)) / 2, oy: (map.H - s * (e.y1 - e.y0)) / 2, e };
}
function toScreen(x, y) {
  const b = baseScale();
  return map.t.apply([b.ox + (x - b.e.x0) * b.s, b.oy + (b.e.y1 - y) * b.s]);
}
function toUTM(px, py) {
  const b = baseScale(), [u, v] = map.t.invert([px, py]);
  return [b.e.x0 + (u - b.ox) / b.s, b.e.y1 - (v - b.oy) / b.s];
}

function hillshade() {
  if (map.hs) return map.hs;
  const { nx, ny, z } = S, hs = new Float32Array(nx * ny);
  const az = (360 - 225 + 90) * Math.PI / 180, alt = 45 * Math.PI / 180;
  for (let r = 1; r < ny - 1; r++) for (let c = 1; c < nx - 1; c++) {
    const i = r * nx + c;
    const dzdx = (z[i + 1] - z[i - 1]) / 100, dzdy = (z[i + nx] - z[i - nx]) / 100;
    const slope = Math.atan(Math.hypot(dzdx, dzdy)), aspect = Math.atan2(dzdy, -dzdx);
    hs[i] = Math.max(0, Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspect));
  }
  map.hs = hs;
  return hs;
}
// matplotlib "terrain" between 0.35 and 0.95 (as the notebook map), 2200-4000 m
const TERRAIN = [[0, [0.2, 0.2, 0.6]], [0.15, [0, 0.6, 1]], [0.25, [0, 0.8, 0.4]], [0.5, [1, 1, 0.6]], [0.75, [0.5, 0.36, 0.33]], [1, [1, 1, 1]]];
function terrainRGB(v) {
  const t = 0.35 + 0.6 * Math.min(1, Math.max(0, (v - 2200) / 1800));
  let k = 0; while (k < TERRAIN.length - 2 && t > TERRAIN[k + 1][0]) k++;
  const [t0, a] = TERRAIN[k], [t1, b] = TERRAIN[k + 1], f = (t - t0) / (t1 - t0);
  return a.map((ai, j) => 255 * (ai + f * (b[j] - ai)));
}
const LAYERS = {
  terrain: { name: "Terrain" },
  aso: { name: "ASO snow depth (m)", kind: "seq", lo: 0, hi: 4, f: (i, R) => Y.aso[i] },
  post: { name: "Posterior mean (m)", kind: "seq", lo: 0, hi: 4, f: (i, R) => R.postMean[i] },
  prior: { name: "Prior mean (m)", kind: "seq", lo: 0, hi: 4, f: (i, R) => R.priorMean[i] },
  postBias: { name: "Posterior − ASO (m)", kind: "div", lim: 1.5, f: (i, R) => R.postMean[i] - Y.aso[i] },
  priorBias: { name: "Prior − ASO (m)", kind: "div", lim: 1.5, f: (i, R) => R.priorMean[i] - Y.aso[i] },
  gain: { name: "|post − ASO| − |prior − ASO| (m)", kind: "div", lim: 1, f: (i, R) => Math.abs(R.postMean[i] - Y.aso[i]) - Math.abs(R.priorMean[i] - Y.aso[i]), lab: ["better", "worse"] },
  postSd: { name: "Posterior SD (m)", kind: "seq", lo: 0, hi: 1.2, f: (i, R) => R.postSd[i] },
  update: { name: "Posterior − prior (m)", kind: "div", lim: 1, f: (i, R) => R.postMean[i] - R.priorMean[i] },
};
function layerColor(L) {
  if (L.kind === "seq") { const ip = d3.interpolateLab(C.seqLo, C.seqHi); return (v) => ip(Math.min(1, Math.max(0, (v - L.lo) / (L.hi - L.lo)))); }
  const neg = d3.interpolateLab(C.divMid, C.divNeg), pos = d3.interpolateLab(C.divMid, C.divPos);
  return (v) => (v < 0 ? neg(Math.min(1, -v / L.lim)) : pos(Math.min(1, v / L.lim)));
}

// map layers of the gridded products of the year (snow depth and difference to ASO)
function productLayers() {
  for (const k of Object.keys(LAYERS)) if (k.startsWith("p_") || k.startsWith("pb_")) delete LAYERS[k];
  const sel = $("#layer");
  for (const o of sel.querySelectorAll("option.prod")) o.remove();
  for (const p of prodList()) {
    LAYERS[`p_${p.id}`] = { name: `${p.label} snow depth (m)`, kind: "seq", lo: 0, hi: 4, f: (i) => p.v[i] };
    LAYERS[`pb_${p.id}`] = { name: `${p.label} − ASO (m)`, kind: "div", lim: 1.5, f: (i) => p.v[i] - Y.aso[i] };
    for (const [k, t] of [[`p_${p.id}`, `${p.label} snow depth`], [`pb_${p.id}`, `${p.label} − ASO`]]) {
      const o = new Option(t, k); o.className = "prod"; sel.append(o);
    }
  }
  if (!(state.map.layer in LAYERS)) state.map.layer = "terrain";
  sel.value = state.map.layer;
}
// the map shows the experiment selected first
const MODEL_LAYERS = ["post", "prior", "postBias", "priorBias", "gain", "postSd", "update"];
function rasterImage() {
  const runId = runIds()[0];
  const key = `${state.map.layer}|${runId}|${state.year}|${C.dark}`;
  if (map.imgKey === key) return map.img;
  const { nx, ny, z, mask } = S, hs = hillshade(), L = LAYERS[state.map.layer], R = RUNS[runId];
  const cv = document.createElement("canvas"); cv.width = nx; cv.height = ny;
  const cx = cv.getContext("2d"), im = cx.createImageData(nx, ny);
  const bg = d3.rgb(C.surface), col = L.kind ? layerColor(L) : null;
  for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) {
    const i = r * nx + c, o = ((ny - 1 - r) * nx + c) * 4;
    let rgb;
    if (!L.kind) {
      const t = finite(z[i]) ? terrainRGB(z[i]) : [bg.r, bg.g, bg.b];
      rgb = t.map((v, j) => 0.75 * v + 0.25 * [bg.r, bg.g, bg.b][j]);
    } else {
      const grey = C.dark ? 40 + 60 * hs[i] : 175 + 70 * hs[i];
      rgb = [grey, grey, grey];
      const v = mask[i] ? L.f(i, R) : NaN;
      if (finite(v)) { const cc = d3.rgb(col(v)); rgb = [cc.r, cc.g, cc.b]; }
    }
    const gshade = 255 * hs[i];
    im.data[o] = 0.8 * rgb[0] + 0.2 * gshade; im.data[o + 1] = 0.8 * rgb[1] + 0.2 * gshade; im.data[o + 2] = 0.8 * rgb[2] + 0.2 * gshade; im.data[o + 3] = 255;
  }
  cx.putImageData(im, 0, 0);
  map.img = cv; map.imgKey = key;
  // colour bar
  const cb = $("#colorbar");
  cb.hidden = !L.kind;
  if (L.kind) {
    const cvb = cb.querySelector("canvas"), g2 = cvb.getContext("2d");
    for (let k = 0; k < cvb.width; k++) {
      const v = L.kind === "seq" ? L.lo + (L.hi - L.lo) * k / (cvb.width - 1) : -L.lim + 2 * L.lim * k / (cvb.width - 1);
      g2.fillStyle = col(v); g2.fillRect(k, 0, 1, cvb.height);
    }
    cb.querySelector(".lo").textContent = L.kind === "seq" ? `${L.lo} m` : `−${L.lim} m${L.lab ? ` ${L.lab[0]}` : ""}`;
    cb.querySelector(".hi").textContent = L.kind === "seq" ? `≥ ${L.hi} m` : `+${L.lim} m${L.lab ? ` ${L.lab[1]}` : ""}`;
    cb.setAttribute("aria-label", L.name);
  }
  return cv;
}

let mapSvg, mapCanvas;
function setupMap() {
  const box = $("#map");
  mapCanvas = document.createElement("canvas");
  box.append(mapCanvas);
  mapSvg = d3.select(box).append("svg").attr("role", "img").attr("aria-label", "Map of the East River basin with the two profiles");
  const zoom = d3.zoom().scaleExtent([1, 10])
    .filter((ev) => !ev.target.closest(".handle") && (!ev.ctrlKey || ev.type === "wheel") && !ev.button)
    .on("zoom", (ev) => { map.t = ev.transform; drawMap(); });
  mapSvg.call(zoom).on("dblclick.zoom", null);
  $("#map-reset").addEventListener("click", () => mapSvg.transition().duration(250).call(zoom.transform, d3.zoomIdentity));
  new ResizeObserver(() => drawMap()).observe(box);
}

function drawMap() {
  if (!S || !RUNS[runIds()[0]]) return;
  const box = $("#map");
  map.W = box.clientWidth; map.H = box.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  mapCanvas.width = Math.round(map.W * dpr); mapCanvas.height = Math.round(map.H * dpr);
  const ctx = mapCanvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, map.W, map.H);
  const img = rasterImage(), b = baseScale();
  $("#layer-exp").textContent = MODEL_LAYERS.includes(state.map.layer) ? label(runIds()[0]) : "";
  const [sx0, sy0] = toScreen(b.e.x0, b.e.y1), [sx1, sy1] = toScreen(b.e.x1, b.e.y0);
  ctx.imageSmoothingEnabled = map.t.k < 2.5;
  ctx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0);
  mapSvg.selectAll("*").remove();
  const g = mapSvg.append("g");
  // sub-basins
  if (S._basins) {
    const path = [];
    for (const f of S._basins.features) for (const ln of f.geometry.coordinates) path.push("M" + ln.map((p) => toScreen(p[0], p[1]).map((v) => v.toFixed(1)).join(",")).join("L"));
    g.append("path").attr("d", path.join("")).attr("fill", "none").attr("stroke", alpha(C.surface, 0.85)).attr("stroke-width", 0.8);
  }
  // IC2 cells
  const ic2 = RUNS[runIds()[0]].ic2;
  const icg = g.append("g");
  for (let i = 0; i < ic2.x.length; i++) {
    const [px, py] = toScreen(ic2.x[i], ic2.y[i]);
    icg.append("circle").attr("cx", px).attr("cy", py).attr("r", Math.max(1.3, 0.9 * Math.sqrt(map.t.k))).attr("fill", C.ic2)
      .style("cursor", "pointer").on("click", (ev) => { ev.stopPropagation(); state.ic2 = i; state.seg[2] = null; drawAll(); })
      .append("title").text(`IC2 cell ${i}`);
  }
  if (state.ic2 !== null) {
    const [px, py] = toScreen(ic2.x[state.ic2], ic2.y[state.ic2]);
    g.append("circle").attr("cx", px).attr("cy", py).attr("r", 6).attr("fill", "none").attr("stroke", C.ic2).attr("stroke-width", 2);
  }
  drawProfile1(g);
  drawProfile2(g);
  if (V && V.F) {
    const rows = fieldRows();
    const [px, py] = toScreen(V.F.x, (S.gy[rows[0]] + S.gy[rows[rows.length - 1]]) / 2);
    g.append("path").attr("d", d3.symbol(d3.symbolDiamond, 70)()).attr("transform", `translate(${px},${py})`).attr("fill", C.surface).attr("stroke", C.ink).attr("stroke-width", 1.5);
  }
}

function dragOn(sel, onDrag) {
  sel.classed("handle", true).call(d3.drag().container(mapSvg.node()).on("drag", (ev) => {
    onDrag(...toUTM(ev.x, ev.y), ev);
    drawMap();
    requestUpdate();
  }).on("end", () => requestUpdate()));
}
const HANDLE = () => ({ fill: C.surface, stroke: C.ink, "stroke-width": 1.5 });
function applyAttrs(el, a) { for (const [k, v] of Object.entries(a)) el.attr(k, v); return el; }

function drawProfile1(g) {
  const p = state.p1;
  const xa = p.e0 ?? S.gx[0] - 25, xb = p.e1 ?? S.gx[S.nx - 1] + 25;
  const ya = S.gy[p.row0] - 25, yb = S.gy[p.row0 + p.nrows - 1] + 25, yc = (ya + yb) / 2;
  const [x0, y0] = toScreen(xa, yb), [x1, y1] = toScreen(xb, ya);
  const hgt = Math.max(y1 - y0, 1);
  const pg = g.append("g");
  pg.append("rect").attr("x", x0).attr("y", y0).attr("width", x1 - x0).attr("height", hgt).attr("fill", alpha(C.ink, 0.18)).attr("stroke", C.ink).attr("stroke-width", 0.8);
  // runs with data, as in the notebook map
  if (V) {
    const z = V.V1.z, cc = V.steps1.coord;
    let start = null;
    for (let i = 0; i <= z.length; i++) {
      const okv = i < z.length && finite(z[i]);
      if (okv && start === null) start = i;
      if (!okv && start !== null) {
        const [ax] = toScreen(cc[start] * 1000 - 25, yc), [bx, by] = toScreen(cc[i - 1] * 1000 + 25, yc);
        pg.append("line").attr("x1", ax).attr("x2", bx).attr("y1", by).attr("y2", by).attr("stroke", C.ink).attr("stroke-width", 2.5);
        start = null;
      }
    }
  }
  const body = pg.append("rect").attr("x", x0).attr("y", (y0 + y1) / 2 - Math.max(hgt, 14) / 2).attr("width", x1 - x0).attr("height", Math.max(hgt, 14)).attr("fill", "transparent").style("cursor", "move");
  let grab = null;
  body.classed("handle", true).call(d3.drag().container(mapSvg.node())
    .on("start", (ev) => { const [ux, uy] = toUTM(ev.x, ev.y); grab = { ux, uy, row0: p.row0, e0: p.e0, e1: p.e1 }; })
    .on("drag", (ev) => {
      const [ux, uy] = toUTM(ev.x, ev.y);
      p.row0 = Math.max(0, Math.min(S.ny - p.nrows, grab.row0 + Math.round((uy - grab.uy) / 50)));
      if (grab.e0 !== null && grab.e1 !== null) { p.e0 = grab.e0 + (ux - grab.ux); p.e1 = grab.e1 + (ux - grab.ux); }
      drawMap(); requestUpdate();
    }).on("end", () => requestUpdate()));
  // width: square on the top edge
  const [mx] = toScreen((xa + xb) / 2, yb);
  dragOn(applyAttrs(pg.append("rect").attr("x", mx - 5).attr("y", y0 - 11).attr("width", 10).attr("height", 10), HANDLE()).style("cursor", "ns-resize"),
    (ux, uy) => { const top = Math.round((uy - S.gy[0]) / 50); p.nrows = Math.max(1, Math.min(S.ny - p.row0, top - p.row0 + 1)); });
  // ends
  for (const end of ["e0", "e1"]) {
    const [hx, hy] = toScreen(end === "e0" ? xa : xb, yc);
    dragOn(applyAttrs(pg.append("rect").attr("x", hx - 3.5).attr("y", hy - 10).attr("width", 7).attr("height", 20).attr("rx", 2), HANDLE()).style("cursor", "ew-resize"),
      (ux) => {
        const lo = S.gx[0] - 25, hi = S.gx[S.nx - 1] + 25;
        let v = Math.max(lo, Math.min(hi, ux));
        if (end === "e0") v = Math.min(v, (p.e1 ?? hi) - 500); else v = Math.max(v, (p.e0 ?? lo) + 500);
        p[end] = (end === "e0" && v <= lo + 30) || (end === "e1" && v >= hi - 30) ? null : v;
      });
  }
  text(pg, x0 + 2, y0 - 16, "Longitudinal profile", { "font-size": 10, fill: C.ink, stroke: C.surface, "stroke-width": 3, "paint-order": "stroke" });
}

function drawProfile2(g) {
  const p = state.p2;
  const corner = (t, s) => {
    const x = p.x0 + t * (p.x1 - p.x0), y = p.y0 + t * (p.y1 - p.y0);
    return toScreen(x + s * p.hw, y);
  };
  const pg = g.append("g");
  // the whole chosen track, along which the profile slides
  const tr = track(), [q0x, q0y] = toScreen(tr.a * tr.ymin + tr.b, tr.ymin), [q1x, q1y] = toScreen(tr.a * tr.ymax + tr.b, tr.ymax);
  pg.append("line").attr("x1", q0x).attr("y1", q0y).attr("x2", q1x).attr("y2", q1y).attr("stroke", C.ink).attr("stroke-width", 1).attr("stroke-dasharray", "2 3").attr("opacity", 0.7);
  const poly = [corner(0, -1), corner(1, -1), corner(1, 1), corner(0, 1)];
  pg.append("path").attr("d", "M" + poly.map((q) => q.join(",")).join("L") + "Z").attr("fill", alpha(C.ink, 0.14)).attr("stroke", "none");
  const [a0, b0] = toScreen(p.x0, p.y0), [a1, b1] = toScreen(p.x1, p.y1);
  pg.append("line").attr("x1", a0).attr("y1", b0).attr("x2", a1).attr("y2", b1).attr("stroke", C.ink).attr("stroke-width", 2.5);
  const hit = pg.append("line").attr("x1", a0).attr("y1", b0).attr("x2", a1).attr("y2", b1).attr("stroke", "transparent").attr("stroke-width", 16).style("cursor", "move");
  let grab = null;
  hit.classed("handle", true).call(d3.drag().container(mapSvg.node())
    .on("start", (ev) => { const [, uy] = toUTM(ev.x, ev.y); grab = { uy, y0: p.y0, y1: p.y1 }; })
    .on("drag", (ev) => {
      const [, uy] = toUTM(ev.x, ev.y), [lo, hi] = trackRange();
      const dy = Math.max(lo - Math.min(grab.y0, grab.y1), Math.min(hi - Math.max(grab.y0, grab.y1), uy - grab.uy));
      p.y0 = grab.y0 + dy; p.y1 = grab.y1 + dy;
      applyTrack();
      drawMap(); requestUpdate();
    }).on("end", () => requestUpdate()));
  // ends: moved along the track (the pointer projected on the track line)
  for (const end of [0, 1]) {
    const [hx, hy] = end ? [a1, b1] : [a0, b0];
    dragOn(applyAttrs(pg.append("circle").attr("cx", hx).attr("cy", hy).attr("r", 6), HANDLE()).style("cursor", "move"),
      (ux, uy) => {
        const t = track(), [lo, hi] = trackRange();
        const yp = Math.max(lo, Math.min(hi, (t.a * (ux - t.b) + uy) / (t.a * t.a + 1)));
        if (end) p.y1 = Math.max(yp, p.y0 + 500); else p.y0 = Math.min(yp, p.y1 - 500);
        applyTrack();
      });
  }
  const [wx, wy] = corner(0.5, 1);
  dragOn(applyAttrs(pg.append("rect").attr("x", wx - 5).attr("y", wy - 5).attr("width", 10).attr("height", 10), HANDLE()).style("cursor", "ew-resize"),
    (ux) => {
      const xm = (p.x0 + p.x1) / 2;
      p.hw = Math.max(25, Math.round(Math.abs(ux - xm) / 5) * 5);
    });
  const [lx, ly] = toScreen(p.y0 < p.y1 ? p.x0 : p.x1, Math.min(p.y0, p.y1));
  text(pg, lx - 8, ly + 16, "ICESat-2 profile", { "font-size": 10, fill: C.ink, "text-anchor": "end", stroke: C.surface, "stroke-width": 3, "paint-order": "stroke" });
}

function buildTrackSelect() {
  const sel = $("#track");
  sel.replaceChildren(...Y.tracks.map((t) => new Option(`${t.label}${t.paper ? ", paper" : ""}`, String(t.id))));
  sel.value = String(state.p2.track);
}
// another IC2 track: keep the Northing range where it overlaps the new track (else its whole length)
function setTrack(k) {
  const t = Y.tracks[k];
  if (!t) return;
  const p = state.p2;
  p.track = k;
  const lo = Math.max(Math.min(p.y0, p.y1), t.ymin - 500), hi = Math.min(Math.max(p.y0, p.y1), t.ymax + 500);
  if (hi - lo < 2000) { p.y0 = t.ymin; p.y1 = t.ymax; } else { p.y0 = lo; p.y1 = hi; }
  applyTrack();
  state.seg[2] = null;
  const ic2 = RUNS[runIds()[0]].ic2, s2 = ic2Sets().s2;
  if (s2.length && !s2.includes(state.ic2)) {
    const yy = state.ic2 !== null ? ic2.y[state.ic2] : (p.y0 + p.y1) / 2;
    state.ic2 = s2.reduce((b, i) => (Math.abs(ic2.y[i] - yy) < Math.abs(ic2.y[b] - yy) ? i : b), s2[0]);
  }
  requestUpdate();
}
// chips of the gridded products (all years; those missing in this year are disabled)
function buildProducts() {
  const box = $("#prods");
  box.replaceChildren();
  const all = new Map();
  for (const yr of Object.keys(S.m.years).sort()) for (const p of S.m.years[yr].products || []) if (!all.has(p.id)) all.set(p.id, p);
  $("#ctl-prods").hidden = !all.size;
  for (const [pid, meta] of all) {
    if (!(pid in state.prods)) state.prods[pid] = true;
    const here = !!(Y.prods && Y.prods[pid]);
    const years = Object.keys(S.m.years).filter((yr) => (S.m.years[yr].products || []).some((q) => q.id === pid));
    const b = chip(box, { label: here ? meta.label : `${meta.label} (${years.join(", ")} only)`, key: `prod-${pid}`, pressed: here && state.prods[pid],
      swatch: { cls: meta.dash ? "dash" : "", color: "var(--rean)" }, onToggle: (on) => { state.prods[pid] = on; drawAll(); } });
    b.disabled = !here;
    b.title = meta.desc;
  }
}

// ------------------------------------------------------------------ controls
function chip(container, { label: lab, key, pressed, onToggle, swatch }) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "chip"; b.id = key;
  b.setAttribute("aria-pressed", String(pressed));
  if (swatch) { const s = document.createElement("span"); s.className = `key ${swatch.cls || ""}`; if (swatch.color) s.style.color = swatch.color; b.append(s); }
  b.append(document.createTextNode(lab));
  b.addEventListener("click", () => { const now = b.getAttribute("aria-pressed") !== "true"; if (onToggle(now) !== false) b.setAttribute("aria-pressed", String(now)); });
  container.append(b);
  return b;
}

function buildControls() {
  const ys = $("#year");
  for (const yr of Object.keys(S.m.years).sort()) ys.append(new Option(`${yr} (ASO ${S.m.years[yr].date})`, yr));
  ys.value = state.year;
  ys.addEventListener("change", () => setYear(ys.value));
  const ex = $("#exp");
  for (const e of ["GP", "GC"]) {
    chip(ex, { label: e === "GP" ? "GPE" : "GCE", key: `exp-${e}`, pressed: state.exps.includes(e), swatch: { color: `var(--${e.toLowerCase()})` },
      onToggle: (on) => {
        if (!on && state.exps.length === 1) { flash("Keep at least one experiment."); return false; }
        state.exps = on ? [...state.exps, e] : state.exps.filter((x) => x !== e);   // the first selected is on the map
        loadRunsThenUpdate();
      } });
  }
  const pr = $("#prior");
  chip(pr, { label: "Mean", key: "pr-mean", pressed: state.prior.mean, swatch: { cls: "dash", color: "var(--prior)" }, onToggle: (on) => { state.prior.mean = on; drawAll(); } });
  chip(pr, { label: "Band", key: "pr-band", pressed: state.prior.band, swatch: { cls: "band", color: "var(--prior)" }, onToggle: (on) => { state.prior.band = on; drawAll(); } });
  chip(pr, { label: "Members", key: "pr-memb", pressed: state.prior.members, swatch: { color: "var(--prior)" }, onToggle: (on) => { state.prior.members = on; drawAll(); } });
  const sh = $("#show");
  chip(sh, { label: "Members", key: "sh-memb", pressed: state.show.members, swatch: { color: "var(--gp)" }, onToggle: (on) => { state.show.members = on; drawAll(); } });
  chip(sh, { label: "ASO", key: "sh-aso", pressed: state.show.aso, swatch: { color: "var(--ink)" }, onToggle: (on) => { state.show.aso = on; drawAll(); } });
  chip(sh, { label: "IC2 cells", key: "sh-ic2", pressed: state.show.ic2, swatch: { cls: "dot", color: "var(--ic2)" }, onToggle: (on) => { state.show.ic2 = on; drawAll(); } });
  chip(sh, { label: "IC2 obs.", key: "sh-obs", pressed: state.show.obs, swatch: { cls: "dash", color: "var(--ic2)" }, onToggle: (on) => { state.show.obs = on; drawAll(); } });
  $("#band").addEventListener("change", (ev) => { state.band = ev.target.value === "none" ? null : ev.target.value.split(",").map(Number); requestUpdate(); });
  $("#layer").addEventListener("change", (ev) => { state.map.layer = ev.target.value; drawMap(); });
  $("#track").addEventListener("change", (ev) => setTrack(Number(ev.target.value)));
  // settings form
  const num = (id, get, set) => {
    const el = document.getElementById(id);
    el.addEventListener("change", () => { const v = el.value === "" ? null : Number(el.value); if (v === null || finite(v)) { set(v); requestUpdate(); } });
    inputs.push({ el, get });
  };
  num("p1-n", () => fmt2(S.gy[state.p1.row0 + ((state.p1.nrows - 1) >> 1)] / 1000), (v) => {
    if (v === null) return;
    const r = Math.round((v * 1000 - S.gy[0]) / 50) - ((state.p1.nrows - 1) >> 1);
    state.p1.row0 = Math.max(0, Math.min(S.ny - state.p1.nrows, r));
  });
  num("p1-w", () => state.p1.nrows * 50, (v) => { state.p1.nrows = Math.max(1, Math.min(200, Math.round((v || 50) / 50))); });
  num("p1-e0", () => (state.p1.e0 === null ? "" : fmt2(state.p1.e0 / 1000)), (v) => { state.p1.e0 = v === null ? null : v * 1000; });
  num("p1-e1", () => (state.p1.e1 === null ? "" : fmt2(state.p1.e1 / 1000)), (v) => { state.p1.e1 = v === null ? null : v * 1000; });
  num("p1-k", () => state.p1.k, (v) => { state.p1.k = Math.max(10, v || 300); });
  num("p1-bias", () => state.p1.bias || 0, (v) => { state.p1.bias = v > 0 ? v : 0; });
  num("p2-y0", () => fmt2(state.p2.y0 / 1000), (v) => { if (v === null) return; state.p2.y0 = Math.max(trackRange()[0], Math.min(state.p2.y1 - 500, v * 1000)); applyTrack(); });
  num("p2-y1", () => fmt2(state.p2.y1 / 1000), (v) => { if (v === null) return; state.p2.y1 = Math.min(trackRange()[1], Math.max(state.p2.y0 + 500, v * 1000)); applyTrack(); });
  inputs.push({ el: $("#p2-x0"), get: () => `${fmt2(state.p2.x0 / 1000)} – ${fmt2(state.p2.x1 / 1000)}` });
  num("p2-hw", () => state.p2.hw, (v) => { state.p2.hw = Math.max(25, v || 150); });
  num("p2-cap", () => state.p2.cap, (v) => { state.p2.cap = Math.max(0, v || 0); });
  num("p2-k", () => state.p2.k, (v) => { state.p2.k = Math.max(10, v || 140); });
  num("p2-bias", () => state.p2.bias || 0, (v) => { state.p2.bias = v > 0 ? v : 0; });
  num("pt-e", () => fmt2(state.field.e / 1000), (v) => { if (v !== null) state.field.e = v * 1000; });
  num("pt-snap", () => state.field.snap, (v) => { state.field.snap = Math.max(0, v || 0); });
  num("pt-ic2", () => state.ic2 ?? "", (v) => { const n = RUNS[runIds()[0]].ic2.x.length; if (v !== null) state.ic2 = Math.max(0, Math.min(n - 1, Math.round(v))); });
  num("min-cells", () => state.minCells, (v) => { state.minCells = Math.max(1, Math.round(v || 1)); });
  $("#pt-mode").addEventListener("change", (ev) => { state.field.mode = ev.target.value; requestUpdate(); });
  $("#kde-bw").addEventListener("change", (ev) => { state.kdeBw = ev.target.value; drawAll(); });
  // tools
  $("#copy-nb").addEventListener("click", () => copyText(notebookSettings(), "Notebook settings copied."));
  $("#copy-csv").addEventListener("click", () => copyText(profileCsv(), "Profile data copied as CSV."));
  if (CFG.downloads) { $("#dl-png").hidden = false; $("#dl-png").addEventListener("click", downloadPng); }
  if (CFG.hashState) { $("#link").hidden = false; $("#link").addEventListener("click", () => copyText(location.href, "Link copied.")); }
}
const inputs = [];
function syncInputs() {
  for (const { el, get } of inputs) if (document.activeElement !== el) el.value = get();
  $("#pt-mode").value = state.field.mode;
  $("#track").value = String(state.p2.track);
  $("#year").value = state.year;
}

let flashTimer = null;
function flash(msg) {
  const el = $("#copied");
  el.textContent = msg;
  clearTimeout(flashTimer); flashTimer = setTimeout(() => { el.textContent = ""; }, 3500);
}
function copyText(s, ok) {
  const box = $("#copybox");
  const fallback = () => { box.hidden = false; box.value = s; box.focus(); box.select(); flash("Select and copy the text below."); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(() => { box.hidden = true; flash(ok); }, fallback);
  else fallback();
}

// ------------------------------------------------------------------ year and runs
async function setYear(yr, first = false) {
  const prevIc2 = state.ic2 !== null && Object.keys(RUNS).length ? RUNS[runIds()[0]]?.ic2 : null;
  const prevXY = prevIc2 ? [prevIc2.x[state.ic2], prevIc2.y[state.ic2]] : null;
  state.year = yr;
  $("#year").value = yr;
  setStatus(`Loading water year ${yr}…`, null);
  Y = await S.year(yr);
  const d = Y.defaults;
  if (first) {
    state.p1 = { ...d.p1, bias: d.p1.bias ? Math.max(...d.p1.bias.map(Math.abs)) : 0 };
    state.p2 = { ...d.p2, bias: 0, biasFac: d.p2.bias_fac };
    state.field = { e: d.field.e, snap: d.field.snap, mode: "strip" };
    state.band = d.q; state.minCells = d.min_cells;
  } else {
    // keep the track and the Northing range where the track of this year allows it
    const k = Y.tracks[state.p2.track] ? state.p2.track : d.p2.track, t = Y.tracks[k];
    const lo = Math.max(state.p2.y0, t.ymin - 500), hi = Math.min(state.p2.y1, t.ymax + 500);
    state.p2.track = k;
    if (hi - lo < 2000) { state.p2.y0 = t.ymin; state.p2.y1 = t.ymax; } else { state.p2.y0 = lo; state.p2.y1 = hi; }
  }
  applyTrack();
  state.seg[2] = null;   // the IC2 cells differ between the years
  await loadRuns();
  const ic2 = RUNS[runIds()[0]].ic2;
  if (first) state.ic2 = d.ic2.i;
  else if (prevXY) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < ic2.x.length; i++) { const dd = Math.hypot(ic2.x[i] - prevXY[0], ic2.y[i] - prevXY[1]); if (dd < bd) { bd = dd; best = i; } }
    state.ic2 = best;
  }
  map.imgKey = "";
  buildTrackSelect();
  buildProducts();
  productLayers();
  $("#data-source").textContent = `Survey date ${Y.date}. Runs: ${runIds().map((id) => `${label(id)} = ${S.m.runs[id].run}`).join(", ")}.`;
  applyAsoAvailability();
  requestUpdate();
}
// Without ASO in the data record: no ASO line, no comparison panels, no ASO-based map layers.
function applyAsoAvailability() {
  const has = Y.hasAso;
  if (!has) state.show.aso = false;
  const chipAso = document.getElementById("sh-aso");
  chipAso.disabled = !has;
  chipAso.setAttribute("aria-pressed", String(state.show.aso));
  const asoLayers = ["aso", "postBias", "priorBias", "gain", ...prodList().map((p) => `pb_${p.id}`)];
  for (const v of asoLayers) { const o = $(`#layer option[value="${v}"]`); if (o) o.disabled = !has; }
  if (!has && asoLayers.includes(state.map.layer)) { state.map.layer = "terrain"; $("#layer").value = "terrain"; }
  $("#scores").closest(".card").querySelector(".hint").textContent = has
    ? "All cells of each profile with model values and ASO. Bias and RMSE of the ensemble mean, mean CRPS of the ensemble, and CRPS skill = 1 − CRPS(post) / CRPS(prior). For the gridded products, a single value, the CRPS is the mean absolute error."
    : "The scores compare the ensembles with ASO snow depth, which is not part of this data record.";
}
async function loadRuns() {
  for (const id of runIds()) RUNS[id] = await S.run(id);
}
async function loadRunsThenUpdate() {
  setStatus("Loading experiment…", null);
  await loadRuns();
  map.imgKey = "";
  $("#data-source").textContent = `Survey date ${Y.date}. Runs: ${runIds().map((id) => `${label(id)} = ${S.m.runs[id].run}`).join(", ")}.`;
  requestUpdate();
}

// ------------------------------------------------------------------ exports
function notebookSettings() {
  const p1 = state.p1, p2 = state.p2, rows = stripRows();
  const ic2 = RUNS[runIds()[0]].ic2, s2 = ic2Sets().s2;
  const xs = s2.map((i) => ic2.x[i]);
  const f = (v) => (v === null ? "None" : `${(v / 1000).toFixed(3)}e3`);
  const lines = [
    `# WE_strip_final.ipynb settings for this view (water year ${state.year}, ${runIds().map(label).join(" + ")})`,
    `DATE = "${Y.date}"`,
    `RUN = "${S.m.runs[runIds()[0]].run}"`,
    `Q = (${(state.band || [25, 75]).join(", ")})`,
    `MIN_CELLS = ${state.minCells}`,
    `LONG.update(n_min=${f(S.gy[rows[0]] - 20)}, n_max=${f(S.gy[rows[rows.length - 1]] + 20)}, e_min=${f(p1.e0)}, e_max=${f(p1.e1)}, k=${p1.k}${p1.bias ? `, bias_ylim=(-${p1.bias}, ${p1.bias})` : `, bias_ylim="sym"`})`,
  ];
  if (p2Axis() === "y" && xs.length >= 2) {
    lines.push(`IC2P.update(track_e=(${f(Math.min(...xs) - 1)}, ${f(Math.max(...xs) + 1)}), p0=${f(Math.min(p2.y0, p2.y1))}, p1=${f(Math.max(p2.y0, p2.y1))}, half_width=${p2.hw}, k=${p2.k}${p2.bias ? `, bias_ylim=(-${p2.bias}, ${p2.bias})` : `, bias_ylim="sym"`})`);
    lines.push("# the notebook fits the track line through the IC2 cells with Easting in track_e (profile 2 snapped to that track)");
  } else {
    lines.push(`# profile 2 is not a North-South IC2 track: line (${fmt2(p2.x0 / 1000)}, ${fmt2(p2.y0 / 1000)}) - (${fmt2(p2.x1 / 1000)}, ${fmt2(p2.y1 / 1000)}) km, half-width ${p2.hw} m`);
  }
  lines.push(`PT_FIELD.update(e=${f(state.field.e)}, snap=${state.field.snap}${state.field.mode === "centre" ? `, n=${f(S.gy[fieldRows()[0]])}` : ""})`);
  if (state.ic2 !== null) lines.push(`PT_IC2.update(n=${f(ic2.y[state.ic2])}, idx=None)  # IC2 cell ${state.ic2}`);
  if (state.seg[1]) lines.push(`# segment of a) b): E ${fmt2(state.seg[1].a)}–${fmt2(state.seg[1].b)} km (the notebook has points only)`);
  if (state.seg[2]) lines.push(`# segment of d) e): N ${fmt2(state.seg[2].a)}–${fmt2(state.seg[2].b)} km (the notebook has points only)`);
  return lines.join("\n");
}
function profileCsv() {
  const out = [];
  const head = ["profile", "coord_km", "cells", "elevation_m", "aso_m"];
  for (const id of V.ids) head.push(...["post_mean", "post_lo", "post_hi", "prior_mean", "prior_lo", "prior_hi"].map((k) => `${label(id)}_${k}_m`));
  for (const p of shownProds()) head.push(`${p.label.replace(/\s+/g, "_")}_m`);
  out.push(head.join(","));
  for (const [name, P_, Vp, PR] of [["longitudinal", V.steps1, V.V1, V.PR1], ["profile2", V.steps2, V.V2, V.PR2]]) {
    for (let i = 0; i < P_.coord.length; i++) {
      if (!finite(Vp.z[i])) continue;
      const row = [name, P_.coord[i].toFixed(3), Vp.n[i], Vp.z[i].toFixed(1), Vp.aso[i].toFixed(3)];
      for (const id of V.ids) { const R = Vp.runs[id]; row.push(...[R.mean[i], R.lo[i], R.hi[i], R.prior[i], R.plo[i], R.phi[i]].map((v) => (finite(v) ? v.toFixed(3) : ""))); }
      for (const p of shownProds()) { const v = PR[p.id].vals[i]; row.push(finite(v) ? v.toFixed(3) : ""); }
      out.push(row.join(","));
    }
  }
  return out.join("\n");
}
async function downloadPng() {
  const fig = $("#figure"), r0 = fig.getBoundingClientRect(), scale = 2;
  const cv = document.createElement("canvas");
  cv.width = r0.width * scale; cv.height = r0.height * scale;
  const ctx = cv.getContext("2d");
  ctx.scale(scale, scale);
  ctx.fillStyle = C.surface; ctx.fillRect(0, 0, r0.width, r0.height);
  const draw = async (el) => {
    const r = el.getBoundingClientRect();
    if (el.tagName === "CANVAS") { ctx.drawImage(el, r.left - r0.left, r.top - r0.top, r.width, r.height); return; }
    const s = new XMLSerializer().serializeToString(el);
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s.replace("<svg", `<svg xmlns="http://www.w3.org/2000/svg" width="${r.width}" height="${r.height}"`));
    await img.decode();
    ctx.drawImage(img, r.left - r0.left, r.top - r0.top, r.width, r.height);
  };
  for (const el of fig.querySelectorAll("canvas, svg")) { if (el.closest(".legend")) continue; await draw(el); }
  ctx.fillStyle = C.ink; ctx.font = "600 13px sans-serif";
  for (const h of fig.querySelectorAll("h3")) { const r = h.getBoundingClientRect(); ctx.textAlign = "center"; ctx.fillText(h.textContent, r.left - r0.left + r.width / 2, r.top - r0.top + 14); }
  const a = document.createElement("a");
  a.download = `snow_profiles_WY${state.year}.png`;
  a.href = cv.toDataURL("image/png");
  a.click();
}

// URL hash (GitHub Pages only)
function writeHash() {
  if (!CFG.hashState || !state.p1) return;
  const p1 = state.p1, p2 = state.p2, r = (v) => Math.round(v);
  const seg = (s) => (s ? `${s.a.toFixed(3)}_${s.b.toFixed(3)}` : "");
  const s = ["v2", state.year, state.exps.join("+"), (state.band || ["none"]).join("-"),
    [p1.row0, p1.nrows, p1.e0 ?? "", p1.e1 ?? "", p1.k, p1.bias].join("_"),
    [p2.track, r(p2.y0), r(p2.y1), p2.hw, p2.cap, p2.k, p2.bias].join("_"),
    [r(state.field.e), state.field.snap, state.field.mode, state.ic2 ?? ""].join("_"),
    [+state.prior.mean, +state.prior.band, +state.prior.members, +state.show.members, +state.show.aso, +state.show.ic2, +state.show.obs].join(""),
    state.map.layer, seg(state.seg[1]), seg(state.seg[2]),
    Object.entries(state.prods).map(([k, v]) => `${k}${+v}`).join("_")].join("~");
  history.replaceState(null, "", `#${s}`);
}
function readHash() {
  if (!CFG.hashState || location.hash.length < 3) return null;
  try {
    const parts = decodeURIComponent(location.hash.slice(1)).split("~");
    if (parts[0] !== "v2") return null;   // links from before the track-locked profile 2 open the defaults
    const [, yr, exps, band, a, b, f, flags, layer, s1 = "", s2 = "", pr = ""] = parts;
    const n = (v) => (v === "" ? null : Number(v));
    const [row0, nrows, e0, e1, k1, bias1] = a.split("_").map(n);
    const [trk, y0, y1, hw, cap, k2, bias2] = b.split("_").map(Number);
    const [fe, fsnap, fmode, fic2] = f.split("_");
    const seg = (s) => { if (!s) return null; const [sa, sb] = s.split("_").map(Number); return finite(sa) && finite(sb) && sb > sa ? { a: sa, b: sb } : null; };
    const prods = {};
    for (const t of pr.split("_").filter(Boolean)) prods[t.slice(0, -1)] = t.endsWith("1");
    return { yr, exps: [...new Set(exps.split("+").filter((e) => e === "GP" || e === "GC"))],
      band: band === "none" ? null : band.split("-").map(Number),
      p1: { row0, nrows, e0, e1, k: k1, bias: bias1 }, p2: { track: trk, y0, y1, hw, cap, k: k2, bias: bias2 },
      field: { e: Number(fe), snap: Number(fsnap), mode: fmode }, ic2: fic2 === "" ? null : Number(fic2), flags, layer,
      seg: { 1: seg(s1), 2: seg(s2) }, prods };
  } catch { return null; }
}

// ------------------------------------------------------------------ start
async function main() {
  readColors();
  for (const id of ["pa", "pb", "pc", "pd", "pe", "pf"]) P[id] = new Panel(id);
  setStatus("Loading data…", null);
  S = await new core.Store(core.httpFetcher(urlOf)).init();
  if (!S.m.years[state.year]) state.year = Object.keys(S.m.years).sort().pop();   // data of one year only
  const h = readHash();
  if (h && S.m.years[h.yr]) { state.year = h.yr; if (h.exps.length) state.exps = h.exps; Object.assign(state.prods, h.prods); }
  setupMap();
  buildControls();
  S.basins().then(() => drawMap());
  await setYear(state.year, true);
  if (h) {
    Object.assign(state.p1, h.p1); Object.assign(state.field, h.field);
    if (Y.tracks[h.p2.track] && h.p2.y1 > h.p2.y0) { Object.assign(state.p2, h.p2); applyTrack(); }
    state.band = h.band; state.ic2 = h.ic2; state.seg = h.seg;
    buildTrackSelect(); buildProducts();
    const fl = h.flags.split("").map((v) => v === "1");
    [state.prior.mean, state.prior.band, state.prior.members, state.show.members, state.show.aso, state.show.ic2, state.show.obs] = fl;
    state.map.layer = h.layer in LAYERS ? h.layer : "terrain";
    $("#layer").value = state.map.layer;
    $("#band").value = state.band ? state.band.join(",") : "none";
    for (const [id, on] of [["pr-mean", state.prior.mean], ["pr-band", state.prior.band], ["pr-memb", state.prior.members], ["sh-memb", state.show.members], ["sh-aso", state.show.aso], ["sh-ic2", state.show.ic2], ["sh-obs", state.show.obs], ["exp-GP", state.exps.includes("GP")], ["exp-GC", state.exps.includes("GC")]])
      document.getElementById(id).setAttribute("aria-pressed", String(on));
    requestUpdate();
  }
  let rt = null;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(drawAll, 120); });
  const redraw = () => { map.imgKey = ""; drawAll(); };
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", redraw);
  new MutationObserver(redraw).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && (state.seg[1] || state.seg[2])) { state.seg = { 1: null, 2: null }; requestUpdate(); }
  });
  $("#footer").textContent = `Data ${S.m.created}. ASO snow depth © Airborne Snow Observatories, Inc., shown for visualisation only.`;
}

main().catch((err) => { console.error(err); setStatus(`Could not load the data: ${err.message}. Reload the page to try again.`, null, true); });
