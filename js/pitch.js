// Pitch tracking and tone-contour extraction.
// Pure functions with no browser or Node dependencies, so the exact same code
// builds the reference data (tools/build-references.mjs) and scores students.

export const SAMPLE_RATE = 16000;   // all audio is resampled to this before analysis
export const CONTOUR_POINTS = 30;   // contours are resampled to this many points

const HOP = 160;                    // 10 ms step

// Tunable analysis settings (exported so experiments can adjust them).
export const PARAMS = {
  frame: 480,          // 30 ms analysis window
  f0Min: 60,
  f0Max: 500,
  step: 0.25,          // pitch grid resolution in semitones
  maxJump: 4,          // largest pitch change between frames (semitones)
  voicedDip: 0.3,      // a YIN dip this clear means the frame is certainly voiced
  quiet: 0.06,         // frames quieter than this fraction of the peak are silence
  edge: 0.12,          // the syllable ends where loudness falls below this fraction
  unvoicedCost: 0.6,   // path cost of calling a frame unvoiced
  jumpCost: 0.12,      // path cost per semitone of pitch change between frames
  voicingCost: 0.25,   // path cost of switching between voiced and unvoiced
  maxGap: 10,          // bridge unvoiced gaps up to 100 ms (creaky 3rd tones)
  minFrames: 5,        // fewer voiced frames than this cannot be judged
};

const toSemitones = (hz) => 12 * Math.log2(hz / 100);

// YIN analysis. For every frame returns its loudness and its cumulative mean
// normalised difference function (low values at likely pitch periods).
export function trackPitch(samples, sr = SAMPLE_RATE) {
  const { frame: FRAME, f0Min } = PARAMS;
  const tauMax = Math.ceil(sr / f0Min) + 1;
  const nFrames = Math.max(0, Math.floor((samples.length - FRAME - tauMax) / HOP) + 1);
  const rms = new Float32Array(nFrames);
  const dips = [];

  for (let i = 0; i < nFrames; i++) {
    const start = i * HOP;
    let energy = 0;
    for (let j = 0; j < FRAME; j++) energy += samples[start + j] ** 2;
    rms[i] = Math.sqrt(energy / FRAME);
    if (rms[i] < 1e-4) { dips.push(null); continue; }
    const d = new Float32Array(tauMax + 1);
    let running = 0;
    d[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let sum = 0;
      for (let j = 0; j < FRAME; j++) {
        const diff = samples[start + j] - samples[start + j + tau];
        sum += diff * diff;
      }
      running += sum;
      d[tau] = running > 0 ? (sum * tau) / running : 1;
    }
    dips.push(d);
  }
  return { rms, dips, sr };
}

// Pitch grid shared by all frames.
function pitchGrid(sr) {
  const lo = toSemitones(PARAMS.f0Min), hi = toSemitones(PARAMS.f0Max);
  const st = [], tau = [];
  for (let v = lo; v <= hi; v += PARAMS.step) {
    st.push(v);
    tau.push(sr / (100 * 2 ** (v / 12)));
  }
  return { st, tau };
}

function dipAt(d, tau) {
  const i = Math.floor(tau), f = tau - i;
  return Math.min(1, d[i] * (1 - f) + d[i + 1] * f);
}

// Deepest YIN dip of a frame within the allowed pitch range.
function clearest(d, sr) {
  if (!d) return 1;
  let min = 1;
  for (let tau = Math.floor(sr / PARAMS.f0Max); tau < d.length; tau++) min = Math.min(min, d[tau]);
  return min;
}

// The syllable is the loudest stretch that contains clear voicing. Short
// noises (clicks, breaths) and sounds after the syllable are left out.
export function findSyllable(rms, dips, sr) {
  const n = rms.length;
  let peak = 0;
  for (const r of rms) peak = Math.max(peak, r);
  if (!peak) return null;

  // Loudness of clearly voiced frames, summed over 50 ms.
  const voiced = Array.from(rms, (r, i) => (clearest(dips[i], sr) < PARAMS.voicedDip ? r : 0));
  let best = -1, bestSum = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) sum += voiced[k];
    if (sum > bestSum) { bestSum = sum; best = i; }
  }
  if (best < 0) return null;

  // Grow outwards while it is loud enough, stepping over short dips.
  const edge = peak * PARAMS.edge;
  const grow = (from, step) => {
    let last = from, i = from;
    while (i + step >= 0 && i + step < n) {
      i += step;
      if (rms[i] >= edge) last = i;
      else if (Math.abs(i - last) > 5) break;
    }
    return last;
  };
  return { start: grow(best, -1), end: grow(best, 1), peak };
}

// Chooses one pitch per frame so that the path is both clear (deep YIN dips)
// and smooth (small frame-to-frame changes). Every pitch on a fine grid is
// considered in every frame, so a noisy moment cannot make the track lose its
// place. A syllable is voiced in one piece: the path may be unvoiced before
// and after the voice, never in the middle. This rejects octave errors and
// room-echo artefacts.
export function choosePath(rms, dips, seg, sr) {
  const { unvoicedCost, jumpCost, voicingCost, quiet, step, maxJump } = PARAMS;
  const grid = pitchGrid(sr);
  const S = grid.st.length;
  const PRE = S, POST = S + 1;
  const reach = Math.round(maxJump / step);
  const free = 0.3 / step;
  const move = new Float64Array(reach + 1);
  for (let k = 0; k <= reach; k++) move[k] = jumpCost * Math.max(0, k - free) * step;

  const emit = (t) => {
    const d = dips[t];
    const out = new Float64Array(S + 2);
    const silent = !d || rms[t] < seg.peak * quiet;
    for (let s = 0; s < S; s++) out[s] = silent ? 1.5 : dipAt(d, grid.tau[s]);
    out[PRE] = out[POST] = silent ? 0 : unvoicedCost;
    return out;
  };

  const T = seg.end - seg.start + 1;
  let prev = emit(seg.start);
  prev[POST] = Infinity;
  for (let s = 0; s < S; s++) prev[s] += voicingCost;
  const back = [];
  for (let t = 1; t < T; t++) {
    const e = emit(seg.start + t);
    const cur = new Float64Array(S + 2);
    const from = new Int16Array(S + 2);
    let bestVoiced = Infinity, bestVoicedArg = 0;
    for (let s = 0; s < S; s++) if (prev[s] < bestVoiced) { bestVoiced = prev[s]; bestVoicedArg = s; }
    for (let s = 0; s < S; s++) {
      let best = prev[PRE] + voicingCost, arg = PRE;
      for (let k = -reach; k <= reach; k++) {
        const q = s + k;
        if (q < 0 || q >= S) continue;
        const c = prev[q] + move[Math.abs(k)];
        if (c < best) { best = c; arg = q; }
      }
      cur[s] = best + e[s];
      from[s] = arg;
    }
    cur[PRE] = prev[PRE] + e[PRE];
    from[PRE] = PRE;
    const end = bestVoiced + voicingCost;
    cur[POST] = (prev[POST] <= end ? prev[POST] : end) + e[POST];
    from[POST] = prev[POST] <= end ? POST : bestVoicedArg;
    back.push(from);
    prev = cur;
  }
  let k = POST;
  for (let s = 0; s < S; s++) if (prev[s] < prev[k]) k = s;
  const path = new Array(T);
  for (let t = T - 1; t >= 0; t--) {
    path[t] = k < S ? grid.st[k] : NaN;
    if (t > 0) k = back[t - 1][k];
  }
  return path;
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function resample(values, n) {
  const out = new Array(n);
  if (values.length === 1) return out.fill(values[0]);
  for (let i = 0; i < n; i++) {
    const pos = (i * (values.length - 1)) / (n - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, values.length - 1);
    out[i] = values[lo] + (values[hi] - values[lo]) * (pos - lo);
  }
  return out;
}

// The syllable's pitch contour in semitones, or null when there is not
// enough voiced speech to judge.
export function analyze(samples) {
  const { rms, dips, sr } = trackPitch(samples);
  const seg = findSyllable(rms, dips, sr);
  if (!seg) return null;
  const path = choosePath(rms, dips, seg, sr);

  // Keep the longest voiced stretch, bridging short unvoiced gaps.
  let best = null, cur = null, gap = 0;
  for (let i = 0; i < path.length; i++) {
    if (!Number.isNaN(path[i])) {
      if (cur && gap <= PARAMS.maxGap) cur.end = i;
      else cur = { start: i, end: i, count: 0 };
      cur.count++;
      gap = 0;
      if (!best || cur.count > best.count) best = cur;
    } else if (cur) {
      gap++;
    }
  }
  if (!best || best.count < PARAMS.minFrames) return null;
  const frames = path.slice(best.start, best.end + 1);

  // Fill bridged gaps by linear interpolation.
  for (let i = 0; i < frames.length; i++) {
    if (!Number.isNaN(frames[i])) continue;
    let j = i;
    while (Number.isNaN(frames[j])) j++;
    const a = frames[i - 1], b = frames[j];
    for (let k = i; k < j; k++) frames[k] = a + ((b - a) * (k - i + 1)) / (j - i + 1);
    i = j;
  }

  // 3-point median filter smooths remaining jitter.
  const smooth = frames.map((_, i) =>
    median(frames.slice(Math.max(0, i - 1), Math.min(frames.length, i + 2))));

  // Onset and release frames are unstable; trim them.
  const trim = smooth.length > 20 ? 2 : 0;
  const core = smooth.slice(trim, smooth.length - trim);

  const points = resample(core, CONTOUR_POINTS);
  const mean = points.reduce((a, b) => a + b, 0) / points.length;
  return {
    shape: points.map((v) => v - mean), // contour relative to its own average pitch
    mean,                               // average pitch, semitones re 100 Hz
    duration: frames.length * HOP / SAMPLE_RATE,
  };
}
