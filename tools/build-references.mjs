// Analyzes every clip in audio/ and writes data/references.json with each
// clip's pitch contour, then checks how well the tool recognizes the tones of
// the reference speakers themselves. Requires ffmpeg on PATH.
//   node tools/build-references.mjs

import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { SAMPLE_RATE, analyze } from '../js/pitch.js';
import { TONES, toneDistances } from '../js/scoring.js';

const run = promisify(execFile);
const AUDIO_DIR = new URL('../audio/', import.meta.url);
const OUT = new URL('../data/references.json', import.meta.url);
const NAME = /^([a-z]+)([1-4])_([FM]V[1-3])_MP3\.mp3$/;

async function decode(path) {
  const { stdout } = await run('ffmpeg', [
    '-v', 'error', '-i', path, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-',
  ], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

const round = (v) => Math.round(v * 10) / 10;
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];

function closest(distances) {
  return Object.keys(distances).reduce((a, b) => (distances[a] <= distances[b] ? a : b));
}

async function analyzeAll(files) {
  const clips = [];
  const failed = [];
  const queue = [...files];
  let done = 0;
  async function worker() {
    for (let file; (file = queue.shift()); ) {
      const [, syllable, tone, speaker] = file.match(NAME);
      const contour = analyze(await decode(new URL(file, AUDIO_DIR).pathname));
      if (contour) clips.push({ syllable, tone, speaker, contour });
      else failed.push(file);
      if (++done % 1000 === 0) console.log(`  analyzed ${done}/${files.length}`);
    }
  }
  await Promise.all(Array.from({ length: cpus().length }, worker));
  return { clips, failed };
}

// Turns analyzed clips ({ syllable, tone, speaker, contour }) into the
// reference data, flags clips whose tone is not recognized against the other
// speakers, and reports the self-test results.
export function buildReferences(clips) {
  // Each speaker's baseline is the median pitch over all of their clips.
  const bySpeaker = {};
  for (const c of clips) (bySpeaker[c.speaker] ??= []).push(c.contour.mean);
  const baselines = Object.fromEntries(
    Object.entries(bySpeaker).sort().map(([spk, means]) => [spk, round(median(means))]));

  const syllables = {};
  const key = (c) => c.syllable + c.tone + c.speaker;
  for (const c of [...clips].sort((a, b) => key(a).localeCompare(key(b)))) {
    ((syllables[c.syllable] ??= {})[c.tone] ??= {})[c.speaker] = {
      s: c.contour.shape.map(round),
      r: round(c.contour.mean - baselines[c.speaker]),
      d: Math.round(c.contour.duration * 100) / 100,
    };
  }

  // Leave-one-speaker-out check: judge each clip against the other speakers.
  // Clips whose tone is not recognized (usually a creaky voice that hides the
  // pitch) are marked unreliable and not used as scoring references.
  const confusion = Object.fromEntries(TONES.map((t) => [t, Object.fromEntries(TONES.map((h) => [h, 0]))]));
  const unreliable = [];
  for (const [syl, tones] of Object.entries(syllables)) {
    for (const [tone, speakers] of Object.entries(tones)) {
      for (const [spk, ref] of Object.entries(speakers)) {
        const heard = closest(toneDistances({ shape: ref.s, reg: ref.r }, tones, spk));
        confusion[tone][heard]++;
        if (heard !== tone) unreliable.push([syl, tone, spk]);
      }
    }
  }
  const accuracy = (clips.length - unreliable.length) / clips.length;
  for (const [syl, tone, spk] of unreliable) syllables[syl][tone][spk].x = 1;

  // Typical pitch level of each tone relative to the speaker's baseline.
  const toneLevels = {};
  for (const t of TONES) {
    const levels = clips.filter((c) => c.tone === t && !syllables[c.syllable][t][c.speaker].x)
      .map((c) => c.contour.mean - baselines[c.speaker]);
    toneLevels[t] = round(median(levels));
  }

  const missing = [];
  for (const [syl, tones] of Object.entries(syllables)) {
    for (const t of TONES) if (!Object.values(tones[t] ?? {}).some((r) => !r.x)) missing.push(syl + t);
  }

  return {
    data: { meta: { baselines, toneLevels, selfTestAccuracy: round(accuracy * 100) }, syllables },
    report: { accuracy, confusion, unreliable: unreliable.length, missing },
  };
}

async function main() {
  const files = (await readdir(AUDIO_DIR)).filter((f) => NAME.test(f)).sort();
  console.log(`Analyzing ${files.length} clips...`);
  const { clips, failed } = await analyzeAll(files);
  const { data, report } = buildReferences(clips);
  await writeFile(OUT, JSON.stringify(data));

  console.log(`Wrote ${clips.length} contours for ${Object.keys(data.syllables).length} syllables to data/references.json`);
  if (failed.length) console.log(`No usable pitch in ${failed.length} clips: ${failed.join(', ')}`);
  console.log(`Self-test tone accuracy: ${(report.accuracy * 100).toFixed(1)}%`);
  console.log('Confusion (rows = true tone, columns = heard as 1/2/3/4):');
  for (const t of TONES) console.log(`  ${t}: ${TONES.map((h) => String(report.confusion[t][h]).padStart(5)).join('')}`);
  console.log(`${report.unreliable} clips marked unreliable (still playable, not used for scoring).`);
  if (report.missing.length) console.log(`No reliable reference for: ${report.missing.join(', ')}`);
  console.log('Typical tone levels vs speaker baseline (semitones):', data.meta.toneLevels);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
