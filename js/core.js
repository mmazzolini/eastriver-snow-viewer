// core.js - data access and the computations of the West-East strip figure (no DOM).
//
// The same module runs in the page and in the Node check (web/check_core.mjs). The profile, point and
// score computations follow B/Results/WE_strip_final.ipynb:
//   - profile steps along the dominant axis of the line (columns for a W-E line, rows for a N-S line),
//     corridor measured along the other axis;
//   - means over the cells with model and ASO values; fewer than minCells cells -> gap;
//   - band lo/hi = mean over the cells of the per-cell percentiles (numpy "linear" percentiles);
//   - member bias = per-member mean over the cells minus the mean ASO;
//   - KDE = scipy gaussian_kde (Scott's rule), reflected at 0;  CRPS = properscoring.crps_ensemble.
//
// Data files: see web/build_web_data.py (tile format v2: int16 cm, member-major, differences between
// consecutive cells in serpentine order, low and high byte planes, gzip per tile).

export const NODATA = -32768;

// ------------------------------------------------------------------ fetching
/**
 * Fetcher over HTTP: whole files and byte ranges. Merged range requests are served from one response;
 * a server that ignores Range (status 200) is handled by keeping the whole file.
 */
export function httpFetcher(base) {
  const url = typeof base === "function" ? base : (name) => base + name;
  const whole = new Map();   // name -> whole file (server ignores Range)
  const probe = new Map();   // name -> does the server honour Range?
  async function req(url, headers) {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, { headers });
      if (r.ok) return r;
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt));
        continue;
      }
      throw new Error(`${r.status} ${r.statusText} for ${url}`);
    }
  }
  // Files named *.b64.txt hold base64 text (for hosts that serve only text and media types); they are
  // fetched whole, decoded once and sliced.
  const b64 = new Map();
  const decoded = (name) => {
    if (!b64.has(name)) {
      b64.set(name, req(url(name), {}).then((r) => r.text()).then((t) => {
        const s = atob(t.trim()), out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
      }));
    }
    return b64.get(name);
  };
  return {
    async get(name) {
      if (name.endsWith(".b64.txt")) return decoded(name);
      const r = await req(url(name), {});
      return new Uint8Array(await r.arrayBuffer());
    },
    async range(name, start, len) {
      if (name.endsWith(".b64.txt")) return (await decoded(name)).subarray(start, start + len);
      // The first request to a file tells whether the server honours Range (206); requests made while
      // it is pending wait for the answer, so a server that sends whole files is asked only once.
      if (probe.has(name) && !(await probe.get(name))) return (await whole.get(name)).subarray(start, start + len);
      const p = req(url(name), { Range: `bytes=${start}-${start + len - 1}` }).then(async (r) => {
        if (r.status === 206) return { ok: true, bytes: new Uint8Array(await r.arrayBuffer()) };
        if (!whole.has(name)) whole.set(name, r.arrayBuffer().then((b) => new Uint8Array(b)));
        return { ok: false };
      });
      if (!probe.has(name)) probe.set(name, p.then((x) => x.ok));
      const x = await p;
      return x.ok ? x.bytes : (await whole.get(name)).subarray(start, start + len);
    },
  };
}

/** gzip -> bytes; data that is not gzip (a server that already decoded it) is returned as is. */
export async function gunzip(bytes) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const text = (b) => new TextDecoder().decode(b);

// ------------------------------------------------------------------ store
export class Store {
  constructor(fetcher, { maxTiles = 160 } = {}) {
    this.f = fetcher;
    this.maxTiles = maxTiles;
    this.tiles = new Map();     // key `${run}:${t}` -> decoded tile (insertion order = LRU)
    this.pending = new Map();
    this.years = new Map();
    this.runs = new Map();
  }

  async init() {
    this.m = JSON.parse(text(await this.f.get("manifest.json")));
    const g = this.m.grid;
    this.nx = g.nx; this.ny = g.ny; this.T = g.tile; this.ntc = g.ntc; this.ntr = g.ntr;
    this.gx = Float64Array.from(g.x); this.gy = Float64Array.from(g.y);
    this.dx = this.gx[1] - this.gx[0]; this.dy = this.gy[1] - this.gy[0];
    const [mask, z] = await Promise.all([this.f.get(this.m.files.mask), this.f.get(this.m.files.z)]);
    this.mask = await gunzip(mask);
    const zb = await gunzip(z);
    this.z = new Float32Array(zb.buffer, zb.byteOffset, this.nx * this.ny);
    this.nmem = Object.values(this.m.runs)[0].n_mem;
    this.unit = this.m.tile_unit_m;
    return this;
  }

  async basins() {
    if (!this._basins) this._basins = JSON.parse(text(await this.f.get(this.m.files.basins)));
    return this._basins;
  }

  /**
   * ASO (m, NaN = missing) and the ok mask (model and ASO) of a water year. Without an ASO file (a data
   * record that cannot redistribute ASO) every model cell is ok and hasAso is false.
   */
  async year(yr) {
    if (!this.years.has(yr)) {
      this.years.set(yr, (async () => {
        const meta = this.m.years[yr];
        let raw = null;   // meta.aso = null: the data record has no ASO
        if (meta.aso) { try { raw = await this.f.get(meta.aso); } catch (err) { raw = null; } }
        const prods = await this.products(meta.products || []);
        if (!raw) {
          const n = this.nx * this.ny;
          return { ...meta, aso: new Float32Array(n).fill(NaN), ok: Uint8Array.from(this.mask), hasAso: false, prods };
        }
        const b = await gunzip(raw);
        const mm = new Int16Array(b.buffer, b.byteOffset, this.nx * this.ny);
        const aso = new Float32Array(mm.length);
        const ok = new Uint8Array(mm.length);
        for (let i = 0; i < mm.length; i++) {
          aso[i] = mm[i] === NODATA ? NaN : mm[i] / 1000;
          ok[i] = this.mask[i] && mm[i] !== NODATA ? 1 : 0;
        }
        return { ...meta, aso, ok, hasAso: true, prods };
      })());
    }
    return this.years.get(yr);
  }

  /** Gridded snow products of a year: { id: { ...meta, v: Float32Array (m, NaN = missing) } }; missing files are skipped. */
  async products(list) {
    const out = {};
    for (const meta of list) {
      let raw = null;
      try { raw = await this.f.get(meta.file); } catch (err) { raw = null; }
      if (!raw) continue;
      const b = await gunzip(raw);
      const mm = new Int16Array(b.buffer, b.byteOffset, this.nx * this.ny);
      out[meta.id] = { ...meta, v: Float32Array.from(mm, (v) => (v === NODATA ? NaN : v / 1000)) };
    }
    return out;
  }

  /** Map summary (prior mean, prior SD, posterior mean, posterior SD, m) and IC2 cells of a run. */
  async run(id) {
    if (!this.runs.has(id)) {
      this.runs.set(id, (async () => {
        const meta = this.m.runs[id];
        const [sb, ib] = await Promise.all([this.f.get(meta.summary), this.f.get(meta.ic2)]);
        const s = await gunzip(sb);
        const mm = new Int16Array(s.buffer, s.byteOffset, 4 * this.nx * this.ny);
        const n = this.nx * this.ny;
        const field = (k) => {
          const out = new Float32Array(n);
          for (let i = 0; i < n; i++) { const v = mm[k * n + i]; out[i] = v === NODATA ? NaN : v / 1000; }
          return out;
        };
        const ic2 = JSON.parse(text(ib));
        ic2.post = ic2.post.map((r) => Float64Array.from(r, (v) => v / 1000));
        ic2.prior = ic2.prior.map((r) => Float64Array.from(r, (v) => v / 1000));
        ic2.aso = ic2.aso.map((v) => (v === null ? NaN : v));
        return { ...meta, priorMean: field(0), priorSd: field(1), postMean: field(2), postSd: field(3), ic2 };
      })());
    }
    return this.runs.get(id);
  }

  tileIndex(cell) {
    const r = Math.floor(cell / this.nx), c = cell % this.nx;
    return Math.floor(r / this.T) * this.ntc + Math.floor(c / this.T);
  }

  /** Load the tiles of `cells` for the runs; merged range requests per pack. */
  async ensureTiles(runIds, cells, onProgress) {
    const need = new Set();
    for (const c of cells) need.add(this.tileIndex(c));
    const jobs = [];
    for (const id of runIds) {
      const index = this.m.runs[id].tiles;
      const todo = [...need].filter((t) => index[t] && !this.tiles.has(`${id}:${t}`));
      const byPack = new Map();
      for (const t of todo) {
        const key = `${id}:${t}`;
        if (this.pending.has(key)) { jobs.push(this.pending.get(key)); continue; }
        const [pack, off, len] = index[t];
        if (!byPack.has(pack)) byPack.set(pack, []);
        byPack.get(pack).push({ t, off, len });
      }
      for (const [pack, list] of byPack) {
        list.sort((a, b) => a.off - b.off);
        const groups = [];
        for (const it of list) {
          const g = groups[groups.length - 1];
          if (g && it.off === g.end) { g.items.push(it); g.end = it.off + it.len; }
          else groups.push({ start: it.off, end: it.off + it.len, items: [it] });
        }
        for (const g of groups) {
          const p = this.f.range(this.m.runs[id].packs[pack], g.start, g.end - g.start).then(async (bytes) => {
            for (const it of g.items) {
              const tile = await this.decodeTile(it.t, bytes.subarray(it.off - g.start, it.off - g.start + it.len));
              this.putTile(`${id}:${it.t}`, tile);
              this.pending.delete(`${id}:${it.t}`);
            }
          });
          for (const it of g.items) this.pending.set(`${id}:${it.t}`, p);
          jobs.push(p);
        }
      }
    }
    let done = 0;
    if (onProgress) onProgress(0, jobs.length);
    await Promise.all(jobs.map((p) => p.then(() => onProgress && onProgress(++done, jobs.length))));
  }

  putTile(key, tile) {
    this.tiles.set(key, tile);
    while (this.tiles.size > this.maxTiles) this.tiles.delete(this.tiles.keys().next().value);
  }

  /** Cells of a tile in storage order: rows south to north, serpentine within the rows. */
  tileCells(t) {
    const T = this.T, r0 = Math.floor(t / this.ntc) * T, c0 = (t % this.ntc) * T;
    const cells = [];
    for (let r = r0; r < Math.min(r0 + T, this.ny); r++) {
      const cs = [];
      for (let c = c0; c < Math.min(c0 + T, this.nx); c++) if (this.mask[r * this.nx + c]) cs.push(r * this.nx + c);
      if ((r - r0) % 2 === 1) cs.reverse();
      cells.push(...cs);
    }
    return cells;
  }

  async decodeTile(t, gz) {
    const b = await gunzip(gz);
    const n = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
    const cells = this.tileCells(t);
    if (cells.length !== n) throw new Error(`tile ${t}: ${n} cells in the file, ${cells.length} in the mask`);
    const M = this.nmem, N = M * n;
    const pos = new Map();
    cells.forEach((c, j) => pos.set(c, j));
    const field = (offset) => {
      const lo = b.subarray(offset, offset + N), hi = b.subarray(offset + N, offset + 2 * N);
      const out = new Int16Array(N);
      for (let k = 0; k < M; k++) {
        let acc = 0;
        for (let j = 0, i = k * n; j < n; j++, i++) {
          let d = lo[i] | (hi[i] << 8);
          if (d >= 32768) d -= 65536;
          acc += d;
          out[i] = acc;
        }
      }
      return out;
    };
    return { n, pos, post: field(4), prior: field(4 + 2 * N) };
  }

  /** Members (m) of `cell` for field "post" | "prior" into out (Float64Array(nmem)); false if missing. */
  members(id, cell, which, out) {
    const tile = this.tiles.get(`${id}:${this.tileIndex(cell)}`);
    if (!tile) return false;
    const j = tile.pos.get(cell);
    if (j === undefined) return false;
    const v = tile[which], n = tile.n;
    for (let k = 0; k < this.nmem; k++) out[k] = v[k * n + j] * this.unit;
    return true;
  }
}

// ------------------------------------------------------------------ statistics
/** numpy.percentile(v, p) with the default "linear" method; v sorted ascending. */
export function pctSorted(v, p) {
  const pos = (p / 100) * (v.length - 1), lo = Math.floor(pos), f = pos - lo;
  return lo + 1 < v.length ? v[lo] + f * (v[lo + 1] - v[lo]) : v[lo];
}

export function mean(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return s / v.length;
}

export function std(v, ddof = 0) {
  const m = mean(v);
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] - m) ** 2;
  return Math.sqrt(s / (v.length - ddof));
}

/** properscoring.crps_ensemble(obs, members) for one cell; sorted = members sorted ascending. */
export function crpsSorted(sorted, obs) {
  const m = sorted.length;
  let a = 0, b = 0;
  for (let i = 0; i < m; i++) {
    a += Math.abs(sorted[i] - obs);
    b += (2 * (i + 1) - m - 1) * sorted[i];
  }
  return a / m - b / (m * m);
}

/** scipy gaussian_kde(values, bw_method) evaluated on grid; reflect = mirror at 0 (no density below 0). */
export function kde(values, grid, { bw = "scott", reflect = true } = {}) {
  const n = values.length;
  const out = new Float64Array(grid.length);
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (hi - lo < 1e-6) return out;
  const factor = typeof bw === "number" ? bw : bw === "silverman" ? (n * 3 / 4) ** -0.2 : n ** -0.2;
  const h = std(values, 1) * factor;
  const norm = 1 / (n * h * Math.sqrt(2 * Math.PI));
  const k = (g) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Math.exp(-0.5 * ((g - values[i]) / h) ** 2);
    return s * norm;
  };
  for (let i = 0; i < grid.length; i++) {
    const g = grid[i];
    out[i] = !reflect ? k(g) : g >= 0 ? k(g) + k(-g) : 0;
  }
  return out;
}

// ------------------------------------------------------------------ profile geometry
/**
 * Profile 1, West-East strip: rows row0 .. row0 + nrows - 1, one step per column with e0 <= x <= e1
 * (null = basin edge). Returns { axis: "x", coord (km), steps: [Int32Array of cells] }.
 */
export function stripSteps(S, { row0, nrows, e0 = null, e1 = null }) {
  const coord = [], steps = [];
  for (let c = 0; c < S.nx; c++) {
    const x = S.gx[c];
    if ((e0 !== null && x < e0) || (e1 !== null && x > e1)) continue;
    const cells = [];
    for (let r = row0; r < row0 + nrows; r++) if (r >= 0 && r < S.ny) cells.push(r * S.nx + c);
    coord.push(x / 1000);
    steps.push(Int32Array.from(cells));
  }
  return { axis: "x", coord: Float64Array.from(coord), steps };
}

/**
 * Profile 2, line (x0, y0) - (x1, y1) with corridor half-width hw (m). Steps along the dominant axis;
 * cells of a step = the cells of that row (column) within hw of the line along the other axis.
 */
export function lineSteps(S, { x0, y0, x1, y1, hw }) {
  const ns = Math.abs(y1 - y0) >= Math.abs(x1 - x0);
  const coord = [], steps = [];
  if (ns) {
    const ya = Math.min(y0, y1), yb = Math.max(y0, y1);
    for (let r = 0; r < S.ny; r++) {
      const y = S.gy[r];
      if (y < ya || y > yb) continue;
      const xl = y1 === y0 ? x0 : x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
      const cells = [];
      const c0 = Math.max(0, Math.floor((xl - hw - S.gx[0]) / S.dx) - 1);
      const c1 = Math.min(S.nx - 1, Math.ceil((xl + hw - S.gx[0]) / S.dx) + 1);
      for (let c = c0; c <= c1; c++) if (Math.abs(S.gx[c] - xl) <= hw) cells.push(r * S.nx + c);
      coord.push(y / 1000);
      steps.push(Int32Array.from(cells));
    }
    return { axis: "y", coord: Float64Array.from(coord), steps };
  }
  const xa = Math.min(x0, x1), xb = Math.max(x0, x1);
  for (let c = 0; c < S.nx; c++) {
    const x = S.gx[c];
    if (x < xa || x > xb) continue;
    const yl = x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
    const cells = [];
    const r0 = Math.max(0, Math.floor((yl - hw - S.gy[0]) / S.dy) - 1);
    const r1 = Math.min(S.ny - 1, Math.ceil((yl + hw - S.gy[0]) / S.dy) + 1);
    for (let r = r0; r <= r1; r++) if (Math.abs(S.gy[r] - yl) <= hw) cells.push(r * S.nx + c);
    coord.push(x / 1000);
    steps.push(Int32Array.from(cells));
  }
  return { axis: "x", coord: Float64Array.from(coord), steps };
}

/** All cells of a step list (for tile loading). */
export function stepCells(P) {
  const out = [];
  for (const s of P.steps) for (const c of s) out.push(c);
  return out;
}

// ------------------------------------------------------------------ profile values
/**
 * Values of every step for each run (the notebook's profile()):
 *   shared: z, aso, n (cells used);  per run: mean, prior, lo, hi, plo, phi (m),
 *   memb, pmemb (Float64Array nmem * nsteps, member k of step i at i * nmem + k): member mean - ASO mean.
 * Also the per-cell scores over all the cells used (bias, RMSE, CRPS of prior and posterior).
 */
export function computeProfile(S, Y, runIds, P, { q = [25, 75], minCells = 1 } = {}) {
  const ns = P.steps.length, M = S.nmem;
  const nan = () => new Float64Array(ns).fill(NaN);
  const out = { z: nan(), aso: nan(), n: new Int32Array(ns), runs: {} };
  for (const id of runIds) {
    out.runs[id] = { mean: nan(), prior: nan(), lo: nan(), hi: nan(), plo: nan(), phi: nan(),
      memb: new Float64Array(ns * M).fill(NaN), pmemb: new Float64Array(ns * M).fill(NaN),
      score: { n: 0, biasPost: 0, biasPrior: 0, msePost: 0, msePrior: 0, crpsPost: 0, crpsPrior: 0 } };
  }
  const buf = new Float64Array(M), srt = new Float64Array(M);
  for (let i = 0; i < ns; i++) {
    const cells = P.steps[i].filter((c) => Y.ok[c]);
    if (cells.length < minCells || cells.length === 0) continue;
    out.n[i] = cells.length;
    let zs = 0, as = 0;
    for (const c of cells) { zs += S.z[c]; as += Y.aso[c]; }
    out.z[i] = zs / cells.length;
    out.aso[i] = as / cells.length;
    for (const id of runIds) {
      const R = out.runs[id];
      for (const which of ["post", "prior"]) {
        let sum = 0, slo = 0, shi = 0, used = 0;
        const acc = new Float64Array(M);
        for (const c of cells) {
          if (!S.members(id, c, which, buf)) continue;
          used++;
          let cs = 0;
          for (let k = 0; k < M; k++) { acc[k] += buf[k] - Y.aso[c]; cs += buf[k]; }
          sum += cs;
          srt.set(buf); srt.sort();
          slo += pctSorted(srt, q[0]); shi += pctSorted(srt, q[1]);
          const sc = R.score, a = Y.aso[c], em = cs / M;
          if (which === "post") { sc.n++; sc.biasPost += em - a; sc.msePost += (em - a) ** 2; sc.crpsPost += crpsSorted(srt, a); }
          else { sc.biasPrior += em - a; sc.msePrior += (em - a) ** 2; sc.crpsPrior += crpsSorted(srt, a); }
        }
        if (used !== cells.length) continue;   // tiles not loaded yet
        const m = which === "post" ? R.memb : R.pmemb;
        for (let k = 0; k < M; k++) m[i * M + k] = acc[k] / used;
        if (which === "post") { R.mean[i] = sum / (used * M); R.lo[i] = slo / used; R.hi[i] = shi / used; }
        else { R.prior[i] = sum / (used * M); R.plo[i] = slo / used; R.phi[i] = shi / used; }
      }
    }
  }
  for (const id of runIds) {
    const sc = out.runs[id].score;
    if (sc.n) {
      for (const k of ["biasPost", "biasPrior", "crpsPost", "crpsPrior"]) sc[k] /= sc.n;
      sc.rmsePost = Math.sqrt(sc.msePost / sc.n); sc.rmsePrior = Math.sqrt(sc.msePrior / sc.n);
      sc.skill = 1 - sc.crpsPost / sc.crpsPrior;
    }
  }
  return out;
}

// ------------------------------------------------------------------ IC2 cells and points
/** IC2 cells in profile 1 (strip rows, Easting extent). */
export function ic2InStrip(S, ic2, { row0, nrows, e0 = null, e1 = null }, needAso = true) {
  const ya = S.gy[row0] - S.dy / 2, yb = S.gy[Math.min(row0 + nrows - 1, S.ny - 1)] + S.dy / 2;
  const out = [];
  for (let i = 0; i < ic2.x.length; i++) {
    const x = ic2.x[i], y = ic2.y[i];
    if (y > ya && y < yb && (e0 === null || x >= e0) && (e1 === null || x <= e1) && (!needAso || Number.isFinite(ic2.aso[i]))) out.push(i);
  }
  return out;
}

/** IC2 cells within `cap` m of the profile-2 line (along the minor axis) and inside its extent. */
export function ic2NearLine(ic2, { x0, y0, x1, y1 }, cap, needAso = true) {
  const ns = Math.abs(y1 - y0) >= Math.abs(x1 - x0);
  const out = [];
  for (let i = 0; i < ic2.x.length; i++) {
    const x = ic2.x[i], y = ic2.y[i];
    if (needAso && !Number.isFinite(ic2.aso[i])) continue;
    if (ns) {
      if (y < Math.min(y0, y1) || y > Math.max(y0, y1)) continue;
      const xl = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
      if (Math.abs(x - xl) <= cap) out.push(i);
    } else {
      if (x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue;
      const yl = y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);
      if (Math.abs(y - yl) <= cap) out.push(i);
    }
  }
  return out;
}

/** Least-squares line x = a y + b (N-S) or y = a x + b (W-E) through IC2 cells; keeps the extent. */
export function snapLine(ic2, idx, L) {
  if (idx.length < 2) return null;
  const ns = Math.abs(L.y1 - L.y0) >= Math.abs(L.x1 - L.x0);
  const u = idx.map((i) => (ns ? ic2.y[i] : ic2.x[i])), v = idx.map((i) => (ns ? ic2.x[i] : ic2.y[i]));
  const mu = mean(u), mv = mean(v);
  let sxy = 0, sxx = 0;
  for (let k = 0; k < u.length; k++) { sxy += (u[k] - mu) * (v[k] - mv); sxx += (u[k] - mu) ** 2; }
  const a = sxx > 0 ? sxy / sxx : 0, b = mv - a * mu;
  return ns ? { ...L, x0: a * L.y0 + b, x1: a * L.y1 + b } : { ...L, y0: a * L.x0 + b, y1: a * L.x1 + b };
}

/**
 * Field point on profile 1 (last notebook cell): the column within +-snap of e with the highest mean
 * terrain over the strip rows, then the per-member mean over the rows with model and ASO.
 */
export function fieldColumn(S, Y, { row0, nrows }, e, snap) {
  let best = -1, bestZ = -Infinity, nearest = 0;
  for (let c = 0; c < S.nx; c++) {
    if (Math.abs(S.gx[c] - e) < Math.abs(S.gx[nearest] - e)) nearest = c;
    if (snap > 0 && Math.abs(S.gx[c] - e) <= snap) {
      let zs = 0, k = 0;
      for (let r = row0; r < row0 + nrows; r++) { const i = r * S.nx + c; if (Y.ok[i]) { zs += S.z[i]; k++; } }
      if (k && zs / k > bestZ) { bestZ = zs / k; best = c; }
    }
  }
  return best >= 0 ? best : nearest;
}

export function fieldPoint(S, Y, runIds, rows, col) {
  return fieldSegment(S, Y, runIds, rows, col, col);
}

/**
 * Per-member means over the cells with model (and ASO) of `rows` in the columns c0 .. c1: a field
 * point (c0 = c1) or a segment of profile 1. Returns null if no cell qualifies or tiles are missing.
 */
export function fieldSegment(S, Y, runIds, rows, c0, c1) {
  const cells = [];
  for (let c = c0; c <= c1; c++) for (const r of rows) { const i = r * S.nx + c; if (Y.ok[i]) cells.push(i); }
  if (!cells.length) return null;
  const M = S.nmem, buf = new Float64Array(M), col = c0;
  const out = { col, c0, c1, x: S.gx[c0], x1: S.gx[c1], cells, aso: mean(cells.map((i) => Y.aso[i])),
    z: mean(cells.map((i) => S.z[i])), runs: {} };
  for (const id of runIds) {
    const r = {};
    for (const which of ["post", "prior"]) {
      const acc = new Float64Array(M);
      for (const c of cells) {
        if (!S.members(id, c, which, buf)) return null;
        for (let k = 0; k < M; k++) acc[k] += buf[k] / cells.length;
      }
      r[which] = acc;
    }
    out.runs[id] = r;
  }
  return out;
}

/**
 * IC2 cells idx of one run averaged member by member: post and prior means, mean observation, the
 * variance of that mean for independent errors (sum r / n^2, R is diagonal in the assimilation) and
 * the mean ASO.
 */
export function ic2Segment(ic2, idx) {
  const n = idx.length, M = ic2.post[idx[0]].length;
  const post = new Float64Array(M), prior = new Float64Array(M);
  let obs = 0, r = 0, aso = 0;
  for (const i of idx) {
    for (let k = 0; k < M; k++) { post[k] += ic2.post[i][k] / n; prior[k] += ic2.prior[i][k] / n; }
    obs += ic2.obs[i] / n; r += ic2.r[i] / (n * n); aso += ic2.aso[i] / n;
  }
  return { n, post, prior, obs, r, aso };
}

/**
 * A gridded product along a profile: the mean over the cells of each step that the profile uses (Y.ok,
 * minCells), and its scores against ASO over those cells (bias, RMSE, mean absolute error = the CRPS of
 * a single value).
 */
export function productProfile(S, Y, v, P, { minCells = 1 } = {}) {
  const ns = P.steps.length, vals = new Float64Array(ns).fill(NaN);
  const score = { n: 0, bias: 0, mse: 0, mae: 0 };
  for (let i = 0; i < ns; i++) {
    const cells = P.steps[i].filter((c) => Y.ok[c]);
    if (cells.length < minCells || cells.length === 0) continue;
    let sum = 0, k = 0;
    for (const c of cells) {
      if (!Number.isFinite(v[c])) continue;
      sum += v[c]; k++;
      const d = v[c] - Y.aso[c];
      if (Number.isFinite(d)) { score.n++; score.bias += d; score.mse += d * d; score.mae += Math.abs(d); }
    }
    if (k === cells.length) vals[i] = sum / k;
  }
  if (score.n) { score.bias /= score.n; score.rmse = Math.sqrt(score.mse / score.n); score.mae /= score.n; }
  return { vals, score };
}

/** Mean of a grid over cells (NaN if any value is missing). */
export function meanOver(v, cells) {
  let s = 0;
  for (const c of cells) s += v[c];
  return cells.length ? s / cells.length : NaN;
}

/** Profile-2 end points on an IC2 track (line x = a y + b) for the Northing range y0 .. y1. */
export function trackLine(track, y0, y1) {
  return { x0: track.a * y0 + track.b, y0, x1: track.a * y1 + track.b, y1 };
}
