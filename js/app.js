import { analyze } from './pitch.js';
import { judge, TONES } from './scoring.js';
import { parse, plain, withTone } from './pinyin.js';
import { record, toAnalysisRate, play, toWav } from './recorder.js';

const $ = (id) => document.getElementById(id);

const TONE_INFO = {
  1: ['1st tone', 'high and level'],
  2: ['2nd tone', 'rising'],
  3: ['3rd tone', 'low and dipping'],
  4: ['4th tone', 'falling'],
};
const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' };
// Pitch-level estimates of the student's normal voice, from the voice setup
// and every practice attempt. Their median is the baseline, so a poor setup
// recording corrects itself as the student practices.
const VOICE_KEY = 'toneCoach.voice.v2';
const MAX_ESTIMATES = 40;
const SETUP_WEIGHT = 3; // each setup recording counts like this many attempts

const state = {
  data: null,
  syl: 'ma',
  tone: '1',
  estimates: loadEstimates(),
  baseline: null,
  recording: null,
  lastAudio: null,
  history: [],
};
state.baseline = medianOf(state.estimates);

// Needs a few recordings before the baseline is trusted.
function medianOf(values) {
  if (values.length < 4) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function loadEstimates() {
  try {
    const v = JSON.parse(localStorage.getItem(VOICE_KEY));
    return Array.isArray(v) ? v.filter(Number.isFinite) : [];
  } catch { return []; }
}

function saveEstimates(estimates) {
  state.estimates = estimates.slice(-MAX_ESTIMATES);
  state.baseline = medianOf(state.estimates);
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(state.estimates)); } catch { /* storage unavailable */ }
  renderVoiceStatus();
}

// What this recording says about the student's normal pitch, given the tone
// they were asked to say.
const voiceEstimate = (contour, tone) => contour.mean - state.data.meta.toneLevels[tone];

const audioFile = (syl, tone, spk) => `audio/${syl}${tone}_${spk}_MP3.mp3`;

function hasClip(syl, tone, spk) {
  // jiao1 FV3 is missing from the bank; the analysis data knows what exists.
  return Boolean(state.data.syllables[syl]?.[tone]?.[spk]);
}

function playReference(syl, tone) {
  let spk = $('speaker').value;
  if (!hasClip(syl, tone, spk)) {
    spk = Object.keys(state.data.syllables[syl][tone])[0];
  }
  new Audio(audioFile(syl, tone, spk)).play().catch(() => {
    setMessage('Could not play the reference audio.', true);
  });
}

function setMessage(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

// ---------- target selection ----------

function select(syl, tone = state.tone) {
  if (!state.data.syllables[syl]) return false;
  state.syl = syl;
  state.tone = tone;
  render();
  return true;
}

function render() {
  const { syl, tone } = state;
  $('target-pinyin').textContent = withTone(syl, tone);
  const [name, desc] = TONE_INFO[tone];
  $('target-name').textContent = `${name} · ${desc}`;
  for (const btn of $('tones').children) {
    const t = btn.dataset.tone;
    btn.firstChild.textContent = withTone(syl, t);
    btn.setAttribute('aria-checked', String(t === tone));
  }
  $('result').hidden = true;
  setMessage('');
}

function buildToneButtons() {
  for (const t of TONES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.dataset.tone = t;
    btn.append(document.createTextNode(''));
    const small = document.createElement('small');
    small.textContent = TONE_INFO[t][1];
    btn.append(small);
    btn.addEventListener('click', () => select(state.syl, t));
    $('tones').append(btn);
  }
}

// ---------- recording and judging ----------

async function capture(onDone, labelEl) {
  if (state.recording) { state.recording.stop(); return; }
  const button = labelEl.closest('button');
  try {
    state.recording = await record((level) => { $('meter-fill').style.width = `${level * 100}%`; });
  } catch (err) {
    setMessage('Microphone access is needed. Allow it in your browser and try again.', true);
    console.error(err);
    return;
  }
  button.classList.add('active');
  const original = labelEl.textContent;
  labelEl.textContent = 'Stop';
  const { samples, sampleRate } = await state.recording.done;
  state.recording = null;
  button.classList.remove('active');
  labelEl.textContent = original;
  $('meter-fill').style.width = '0';
  state.lastAudio = { samples, sampleRate };
  const contour = analyze(await toAnalysisRate(samples, sampleRate));
  onDone(contour);
}

function onPracticeRecorded(contour) {
  if (!contour) {
    $('result').hidden = true;
    setMessage("I couldn't hear a clear voice. Speak a bit louder, closer to the microphone, and try again.", true);
    return;
  }
  setMessage('');
  const { syl, tone } = state;
  const result = judge(contour, state.data.syllables[syl], tone, state.baseline);
  showResult(result);
  saveEstimates([...state.estimates, voiceEstimate(contour, tone)]);
  state.history.unshift({ text: withTone(syl, tone), score: result.score });
  state.history.length = Math.min(state.history.length, 10);
  renderHistory();
}

function showResult({ score, heard, tips, vector, band }) {
  const el = $('score');
  el.textContent = score;
  el.className = `score ${score >= 80 ? 'good' : score >= 55 ? 'ok' : 'bad'}`;
  const target = state.tone;
  $('verdict').textContent =
    heard !== target ? `Heard as ${ORDINAL[heard]} tone. Target was ${ORDINAL[target]}.`
    : score >= 90 ? 'Excellent! Sounds native.'
    : score >= 75 ? 'Good. Your tone is clearly recognizable.'
    : `Recognizable as ${ORDINAL[target]} tone, but the shape needs work.`;
  const list = $('tips');
  list.replaceChildren(...tips.map((t) => Object.assign(document.createElement('li'), { textContent: t })));
  if (state.baseline == null) {
    list.append(Object.assign(document.createElement('li'), {
      textContent: 'Tip: set up your voice (top right) for more accurate 1st and 3rd tone judging.',
    }));
  }
  drawChart(vector, band);
  $('result').hidden = false;
}

function renderHistory() {
  $('history-card').hidden = !state.history.length;
  $('history').replaceChildren(...state.history.map(({ text, score }) => {
    const li = document.createElement('li');
    li.append(Object.assign(document.createElement('span'), { textContent: text }),
      Object.assign(document.createElement('span'), { className: 's', textContent: score }));
    return li;
  }));
}

// ---------- chart ----------

const SVG = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, text) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text) el.textContent = text;
  return el;
}

function drawChart(vector, band) {
  const W = 600, H = 260, L = 96, R = 16, T = 14, B = 30;
  const values = [...vector, ...(band ? [...band.lo, ...band.hi] : [])];
  let lo = Math.min(-6, ...values) - 1, hi = Math.max(6, ...values) + 1;
  const x = (i, n) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const line = (vals) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i, vals.length).toFixed(1)},${y(v).toFixed(1)}`).join('');

  const chart = $('chart');
  chart.replaceChildren();
  for (let v = Math.ceil(lo / 3) * 3; v <= hi; v += 3) {
    chart.append(svg('line', { class: v === 0 ? 'zero' : 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
  }
  const mid = state.baseline != null ? 'your normal' : 'average';
  chart.append(svg('text', { x: 4, y: T + 10 }, 'higher'));
  chart.append(svg('text', { x: 4, y: y(0) + 4 }, mid));
  chart.append(svg('text', { x: 4, y: H - B }, 'lower'));
  chart.append(svg('text', { x: L, y: H - 8 }, 'start'));
  chart.append(svg('text', { x: W - R, y: H - 8, 'text-anchor': 'end' }, 'end'));
  if (band) {
    const n = band.lo.length;
    const pts = [...band.hi.map((v, i) => `${x(i, n)},${y(v)}`), ...band.lo.map((v, i) => `${x(i, n)},${y(v)}`).reverse()];
    chart.append(svg('polygon', { class: 'band', points: pts.join(' ') }));
    chart.append(svg('path', { class: 'ref', d: line(band.mean) }));
  }
  chart.append(svg('path', { class: 'you', d: line(vector) }));
}

// ---------- voice setup ----------

function renderVoiceStatus() {
  const btn = $('voice-status');
  btn.textContent = state.baseline != null ? '✓ Voice set up' : 'Set up my voice';
  btn.classList.toggle('done', state.baseline != null);
}

function openSetup() {
  const steps = $('setup-steps');
  const estimates = [];
  let step = 0;
  steps.replaceChildren(...TONES.map((t) => Object.assign(document.createElement('li'), { textContent: withTone('ma', t) })));
  const mark = () => [...steps.children].forEach((li, i) => {
    li.className = i < step ? 'done' : i === step ? 'current' : '';
  });
  const msg = (text, error = false) => {
    $('setup-message').textContent = text;
    $('setup-message').classList.toggle('error', error);
  };
  mark();
  msg(`Say "${withTone('ma', TONES[0])}" in your normal speaking voice.`);

  const recordBtn = $('setup-record');
  recordBtn.onclick = () => capture((contour) => {
    if (!contour) { msg("I couldn't hear a clear voice. Try again a bit louder.", true); return; }
    const t = TONES[step];
    estimates.push(voiceEstimate(contour, t));
    step++;
    mark();
    if (step < TONES.length) {
      msg(`Now say "${withTone('ma', TONES[step])}".`);
    } else {
      saveEstimates(estimates.flatMap((e) => Array(SETUP_WEIGHT).fill(e)));
      msg('All set!');
      setTimeout(() => $('setup').close(), 700);
    }
  }, recordBtn.querySelector('span:last-child'));
  $('setup').showModal();
}

// ---------- start up ----------

async function init() {
  buildToneButtons();
  try {
    const res = await fetch('data/references.json');
    state.data = await res.json();
  } catch (err) {
    setMessage('Could not load reference data. Open this page through a web server, not as a file.', true);
    console.error(err);
    return;
  }

  const syllables = Object.keys(state.data.syllables);
  $('syllable-list').replaceChildren(...syllables.map((s) => Object.assign(document.createElement('option'), { value: plain(s) })));

  $('syllable-input').addEventListener('change', (e) => {
    const p = parse(e.target.value);
    if (p && select(p.syl, p.tone && p.tone !== '5' ? p.tone : state.tone)) e.target.value = '';
    else setMessage(`"${e.target.value}" is not in the audio bank.`, true);
  });
  $('random').addEventListener('click', () => {
    const syl = syllables[Math.floor(Math.random() * syllables.length)];
    select(syl, TONES[Math.floor(Math.random() * 4)]);
  });
  $('listen').addEventListener('click', () => playReference(state.syl, state.tone));
  $('record').addEventListener('click', () => capture(onPracticeRecorded, $('record-label')));
  $('play-mine').addEventListener('click', () => state.lastAudio && play(state.lastAudio.samples, state.lastAudio.sampleRate));
  $('voice-status').addEventListener('click', openSetup);
  $('save-mine').addEventListener('click', () => {
    if (!state.lastAudio) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(toWav(state.lastAudio.samples, state.lastAudio.sampleRate));
    a.download = `${state.syl}${state.tone}_attempt_${Date.now() % 100000}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  renderVoiceStatus();
  render();
  if (state.baseline == null) openSetup();
}

init();
