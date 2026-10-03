// Pinyin helpers. Syllables are stored as in the audio file names, with "v" for ü.

const MARKS = {
  a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', ü: 'ǖǘǚǜ',
};

const UNMARK = {};
for (const [base, marked] of Object.entries(MARKS)) {
  [...marked].forEach((ch, i) => { UNMARK[ch] = [base, String(i + 1)]; });
}

export const plain = (syl) => syl.replace(/v/g, 'ü');

// "ma", "3" -> "mǎ". The mark goes on a or e, on the o of "ou", else on the last vowel.
export function withTone(syl, tone) {
  const s = plain(syl);
  let idx = s.search(/[ae]/);
  if (idx < 0) idx = s.indexOf('ou');
  if (idx < 0) {
    for (let i = s.length - 1; i >= 0; i--) if (MARKS[s[i]]) { idx = i; break; }
  }
  if (idx < 0) return s;
  return s.slice(0, idx) + MARKS[s[idx]][Number(tone) - 1] + s.slice(idx + 1);
}

// Accepts "ma3", "mǎ", "lü4", "lv4", "lu:4" or just "ma". Returns { syl, tone }.
export function parse(input) {
  let s = input.trim().toLowerCase().replace(/u:/g, 'v').replace(/ü/g, 'v');
  let tone = null;
  s = [...s].map((ch) => {
    if (!UNMARK[ch]) return ch;
    tone = UNMARK[ch][1];
    return UNMARK[ch][0] === 'ü' ? 'v' : UNMARK[ch][0];
  }).join('');
  const m = s.match(/^([a-z]+)([1-5])?$/);
  if (!m) return null;
  return { syl: m[1], tone: m[2] ?? tone };
}
