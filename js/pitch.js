// Pitch tracking and tone-contour extraction.
// Pure functions with no browser or Node dependencies, so the exact same code
// builds the reference data (tools/build-references.mjs) and scores students.

export const SAMPLE_RATE = 16000;   // all audio is resampled to this before analysis
export const CONTOUR_POINTS = 30;   // contours are resampled to this many points

const HOP = 160;                    // 10 ms step

// Tunable analysis settings (exported so tools/evaluate.mjs can experiment).
export const PARAMS = {
  frame: 480,          // 30 ms analysis window
  f0Min: 60,
  f0Max: 500,
  threshold: 0.2,      // YIN: accept the first dip below this
  fallback: 0.45,      // YIN: else accept the deepest dip if below this (0 = off)
  quiet: 0.08,         // frames quieter than this fraction of the peak are ignored
  maxGap: 10,          // bridge unvoiced gaps up to 100 ms (creaky 3rd tones)
  minFrames: 5,        // fewer voiced frames than this cannot be judged
};

// YIN fundamental-frequency estimate for every frame.
// Returns { f0: Float32Array (0 = unvoiced), rms: Float32Array }.
export function trackPitch(samples, sr = SAMPLE_RATE) {
  const { frame: FRAME, f0Min: F0_MIN, f0Max: F0_MAX, threshold: YIN_THRESHOLD } = PARAMS;
  const tauMin = Math.floor(sr / F0_MAX);
  const tauMax = Math.ceil(sr / F0_MIN);
  const nFrames = Math.max(0, Math.floor((samples.length - FRAME - tauMax) / HOP) + 1);
  const f0 = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);
  const d = new Float32Array(tauMax + 1);

  for (let i = 0; i < nFrames; i++) {
    const start = i * HOP;
    let energy = 0;
    for (let j = 0; j < FRAME; j++) energy += samples[start + j] ** 2;
    rms[i] = Math.sqrt(energy / FRAME);
    if (rms[i] < 1e-4) continue;

    // Difference function and cumulative mean normalised difference.
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

    let best = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0 && PARAMS.fallback) {
      let min = tauMin;
      for (let tau = tauMin; tau <= tauMax; tau++) if (d[tau] < d[min]) min = tau;
      if (d[min] < PARAMS.fallback) best = min;
    }
    if (best < 0) continue;

    // Parabolic interpolation around the minimum for sub-sample accuracy.
    let tau = best;
    if (best > tauMin && best < tauMax) {
      const a = d[best - 1], b = d[best], c = d[best + 1];
      const denom = a - 2 * b + c;
      if (denom !== 0) tau = best + (a - c) / (2 * denom);
    }
    f0[i] = sr / tau;
  }

  // Frames much quieter than the loudest part are background noise, not voice.
  let peak = 0;
  for (const r of rms) peak = Math.max(peak, r);
  for (let i = 0; i < nFrames; i++) if (rms[i] < peak * PARAMS.quiet) f0[i] = 0;

  return { f0, rms };
}

const toSemitones = (hz) => 12 * Math.log2(hz / 100);

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

// Removes pitch-tracking errors by following the pitch from its steadiest
// stretch outwards. Real voices move at most about one semitone per 10 ms, so
// a bigger jump is an octave error (corrected) or a glitch (discarded).
function followPitch(st) {
  let anchor = null;
  for (let i = 0; i < st.length; i++) {
    if (Number.isNaN(st[i])) continue;
    let j = i;
    while (j + 1 < st.length && Math.abs(st[j + 1] - st[j]) <= 1) j++;
    if (!anchor || j - i > anchor.end - anchor.start) anchor = { start: i, end: j };
    i = j;
  }
  if (!anchor) return st;

  const out = st.map((v, i) => (i >= anchor.start && i <= anchor.end ? v : NaN));
  for (const dir of [1, -1]) {
    let lastIdx = dir > 0 ? anchor.end : anchor.start;
    for (let i = lastIdx + dir; i >= 0 && i < st.length; i += dir) {
      if (Number.isNaN(st[i])) continue;
      const last = out[lastIdx];
      const gap = Math.abs(i - lastIdx);
      const tolerance = 1.5 + 0.8 * gap;
      // Prefer the measured value; only treat it as an octave error when it
      // cannot be reached otherwise.
      const candidate = [st[i], st[i] - 12, st[i] + 12]
        .find((v) => Math.abs(v - last) <= tolerance);
      if (candidate !== undefined) {
        out[i] = candidate;
        lastIdx = i;
      }
    }
  }
  return out;
}

// Turns a frame-level f0 track into the syllable's pitch contour in semitones.
// Returns null when there is not enough voiced speech to judge.
export function extractContour(f0) {
  const st = followPitch(Array.from(f0, (hz) => (hz > 0 ? toSemitones(hz) : NaN)));

  // Group voiced frames into segments, bridging short gaps.
  const segments = [];
  let current = null;
  let gap = 0;
  for (let i = 0; i < st.length; i++) {
    if (!Number.isNaN(st[i])) {
      if (current && gap <= PARAMS.maxGap) current.end = i;
      else segments.push((current = { start: i, end: i, count: 0 }));
      current.count++;
      gap = 0;
    } else if (current) {
      gap++;
    }
  }

  // The syllable is the segment with the most voiced frames.
  const seg = segments.reduce((a, b) => (!a || b.count > a.count ? b : a), null);
  if (!seg || seg.count < PARAMS.minFrames) return null;
  const frames = st.slice(seg.start, seg.end + 1);

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
    duration: (seg.end - seg.start + 1) * HOP / SAMPLE_RATE,
  };
}

export function analyze(samples) {
  return extractContour(trackPitch(samples).f0);
}
