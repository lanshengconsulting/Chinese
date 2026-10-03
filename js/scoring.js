// Compares a student's pitch contour with the reference speakers' contours.
//
// Contours are compared in semitones relative to the speaker's own normal
// pitch (their "baseline"), so a deep male voice and a high female voice can
// be compared fairly while still telling a high tone 1 from a low tone 3.

export const TONES = ['1', '2', '3', '4'];

const DTW_BAND = 4; // how far (in contour points) timing may stretch when aligning

// Root-mean-square distance in semitones between two contours, after letting
// timing flex slightly (dynamic time warping within a narrow band).
export function contourDistance(a, b) {
  const n = a.length, m = b.length;
  let prev = new Float64Array(m + 1).fill(Infinity);
  let prevLen = new Float64Array(m + 1);
  let cur = new Float64Array(m + 1);
  let curLen = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const jLo = Math.max(1, i - DTW_BAND), jHi = Math.min(m, i + DTW_BAND);
    for (let j = jLo; j <= jHi; j++) {
      let best = prev[j - 1], len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      cur[j] = best + (a[i - 1] - b[j - 1]) ** 2;
      curLen[j] = len + 1;
    }
    [prev, cur] = [cur, prev];
    [prevLen, curLen] = [curLen, prevLen];
  }
  return Math.sqrt(prev[m] / prevLen[m]);
}

// Contour relative to the speaker's baseline, or shape only when unknown.
export function studentVector(contour, baseline) {
  if (baseline == null) return contour.shape;
  return contour.shape.map((v) => v + contour.mean - baseline);
}

const refVector = (ref, useRegister) => (useRegister ? ref.s.map((v) => v + ref.r) : ref.s);

// Usable references for one tone of a syllable ({ speaker: ref }).
function usable(toneRefs, excludeSpeaker) {
  return Object.entries(toneRefs ?? {}).filter(([spk, r]) => !r.x && spk !== excludeSpeaker);
}

// Per tone, the average distance to the two closest native speakers.
export function toneDistances(vector, sylRefs, useRegister, excludeSpeaker = null) {
  const out = {};
  for (const tone of TONES) {
    const ds = usable(sylRefs[tone], excludeSpeaker)
      .map(([, r]) => contourDistance(vector, refVector(r, useRegister)))
      .sort((x, y) => x - y);
    if (!ds.length) continue;
    const k = Math.min(2, ds.length);
    out[tone] = ds.slice(0, k).reduce((a, b) => a + b, 0) / k;
  }
  return out;
}

const closestTone = (distances) =>
  Object.keys(distances).reduce((a, b) => (distances[a] <= distances[b] ? a : b));

// Distance (semitones) that still counts as fully native-like, and the
// distance at which the score reaches zero. Calibrated on the reference
// speakers: about 80% of native clips score 90 or more.
const PERFECT = 1.0;
const ZERO = 6;
const WRONG_TONE_CAP = 40;

export function judge(contour, sylRefs, target, baseline) {
  const useRegister = baseline != null;
  const vector = studentVector(contour, baseline);
  const distances = toneDistances(vector, sylRefs, useRegister);
  const heard = closestTone(distances);
  const d = distances[target];
  let score = Math.round(100 * Math.min(1, Math.max(0, (ZERO - d) / (ZERO - PERFECT))));
  if (heard !== target) score = Math.min(score, WRONG_TONE_CAP);
  const band = referenceBand(sylRefs, target, useRegister);
  const tips = score >= 90 ? [] : feedback(vector, band, target, heard, useRegister);
  return { score, heard, distances, vector, band, tips };
}

// Average reference contour and its spread, for drawing and feedback.
export function referenceBand(sylRefs, tone, useRegister) {
  const vectors = usable(sylRefs[tone]).map(([, r]) => refVector(r, useRegister));
  if (!vectors.length) return null;
  const mean = [], lo = [], hi = [];
  for (let i = 0; i < vectors[0].length; i++) {
    const col = vectors.map((v) => v[i]);
    const mu = col.reduce((a, b) => a + b, 0) / col.length;
    const sd = Math.sqrt(col.reduce((a, b) => a + (b - mu) ** 2, 0) / col.length);
    const spread = Math.max(sd, 0.8);
    mean.push(mu); lo.push(mu - spread); hi.push(mu + spread);
  }
  return { mean, lo, hi };
}

const TONE_NAMES = { 1: '1st tone (high, level)', 2: '2nd tone (rising)', 3: '3rd tone (low, dipping)', 4: '4th tone (falling)' };

function features(v) {
  const n = v.length;
  const avg = (a, b) => v.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
  const start = avg(0, 4), end = avg(n - 4, n), level = avg(0, n);
  const min = Math.min(...v);
  return { start, end, level, min, change: end - start, range: Math.max(...v) - min };
}

const st = (x) => `${Math.abs(x).toFixed(0)} semitone${Math.abs(x).toFixed(0) === '1' ? '' : 's'}`;

// Short, practical tips comparing the student's contour with the natives'.
export function feedback(vector, band, target, heard, useRegister) {
  if (!band) return [];
  const s = features(vector), r = features(band.mean);
  const tips = [];
  if (heard !== target) tips.push(`That sounded closer to the ${TONE_NAMES[heard]}.`);

  if (target === '1') {
    if (s.range > 3) tips.push('Keep the pitch flat and steady from start to finish.');
    if (s.change < -2) tips.push('Your pitch dropped at the end. Hold it level.');
    if (s.change > 2) tips.push('Your pitch rose. Hold it level.');
    if (useRegister && s.level < r.level - 2) tips.push('Start higher: the 1st tone sits near the top of your voice.');
  } else if (target === '2') {
    if (s.change < r.change - 2.5) tips.push(`Rise more: natives climb about ${st(r.change)}, you rose ${st(Math.max(0, s.change))}.`);
    if (useRegister && s.start > r.start + 2.5) tips.push('Start from a lower, middle pitch before rising.');
    if (s.change < 0) tips.push('Make sure the pitch goes up, like asking "What?"');
  } else if (target === '3') {
    if (useRegister && s.min > r.min + 2) tips.push('Go lower: the 3rd tone dips to the bottom of your voice.');
    if (useRegister && s.level > r.level + 2.5) tips.push('Your pitch stayed too high overall. Relax and drop down.');
    if (s.start - s.min < 1 && r.start - r.min > 2) tips.push('Let the pitch dip down before it comes back up.');
  } else if (target === '4') {
    if (s.change > r.change + 2.5) tips.push(`Fall further: natives drop about ${st(r.change)}, you dropped ${st(Math.min(0, s.change))}.`);
    if (useRegister && s.start < r.start - 2.5) tips.push('Start higher, then drop sharply, like a firm "No!"');
    if (s.change > 0) tips.push('Make sure the pitch goes down, not up.');
  }
  return tips;
}
