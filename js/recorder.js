// Microphone capture. Records raw samples (no lossy codec), stops on its own
// shortly after the student finishes speaking, and resamples for analysis.

import { SAMPLE_RATE } from './pitch.js';

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture', Capture);
`;

const MAX_SECONDS = 4;
const SILENCE_AFTER_SPEECH = 0.6; // seconds of quiet that end the recording

let ctx = null;
let stream = null;

async function setup() {
  if (!ctx) {
    ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
  }
  if (!stream) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  }
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

// Starts recording. onLevel(0..1) is called for a live meter.
// Returns { stop(), done: Promise<{ samples, sampleRate }> }.
export async function record(onLevel = () => {}) {
  const ac = await setup();
  const source = ac.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ac, 'capture');
  source.connect(node);

  const chunks = [];
  let total = 0;
  let noise = Infinity;
  let spoke = false;
  let quiet = 0;
  let resolve;
  const done = new Promise((r) => { resolve = r; });

  const finish = () => {
    node.port.onmessage = null;
    source.disconnect();
    node.disconnect();
    const samples = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { samples.set(c, off); off += c.length; }
    resolve({ samples, sampleRate: ac.sampleRate });
  };

  node.port.onmessage = ({ data }) => {
    chunks.push(data);
    total += data.length;
    let e = 0;
    for (const v of data) e += v * v;
    const rms = Math.sqrt(e / data.length);
    onLevel(Math.min(1, rms * 8));

    const t = total / ac.sampleRate;
    if (t < 0.2) { noise = Math.min(noise, rms); return; }
    const threshold = Math.max(0.01, noise * 4);
    if (rms > threshold) { spoke = true; quiet = 0; }
    else if (spoke) quiet += data.length / ac.sampleRate;
    if ((spoke && quiet > SILENCE_AFTER_SPEECH) || t > MAX_SECONDS) finish();
  };

  return { stop: finish, done };
}

export async function toAnalysisRate(samples, sampleRate) {
  if (sampleRate === SAMPLE_RATE) return samples;
  const length = Math.ceil((samples.length * SAMPLE_RATE) / sampleRate);
  const off = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const buf = off.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

export function play(samples, sampleRate) {
  if (!ctx) return;
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
}

// 16-bit mono WAV file of a recording, for saving.
export function toWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 0x7fff, true));
  return new Blob([buf], { type: 'audio/wav' });
}
