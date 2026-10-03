# Tone Coach

A web app where students say a Mandarin syllable and get a score for their **tone**, judged against six native speakers from the audio bank (3 female, 3 male, 410 syllables × 4 tones).

## How it works

1. **Voice setup.** The student says mā, má, mǎ, mà once. This tells the app what "high" and "low" mean for that person's voice, so a deep male voice and a high female voice are judged fairly. It's saved in the browser and can be redone from the button at the top right.
2. **Practice.** Pick a syllable (type `ma3`, `mǎ`, `lü4`, or press Random), listen to any of the six native voices, and press Record. Recording stops automatically after the student finishes speaking.
3. **Result.** The app tracks the pitch of the recording, compares its contour with the native speakers' contours for that syllable, and shows:
   - a score from 0 to 100,
   - which tone it actually heard (if different from the target),
   - practical tips (e.g. "Fall further: natives drop about 8 semitones, you dropped 3"),
   - a chart of the student's pitch over the native speakers' range.

Everything runs in the browser. No audio leaves the student's computer.

## Accuracy

Two checks, both run on the audio bank itself:

- **Self-test** (`tools/build-references.mjs`): each clip is judged against the *other five* speakers. **92.4%** of native clips are recognized as the correct tone.
- **Student simulation:** each speaker in turn plays the student. They do the 4-syllable voice setup, then their clips are scored against the other five speakers, with background noise and room echo added. With mild room echo, native tones are recognized 99% (1st), 98% (2nd), 68% (3rd) and 81% (4th) of the time.

What makes it hard:
- **Room echo hides the end of a 4th tone.** The echo of its loud, high start covers its quiet, low end, so the app compares the opening part of the fall too.
- **The 3rd tone is the weakest.** Several reference speakers finish an isolated 3rd tone with a strong rise, which overlaps with the 2nd tone.
- **The voice setup can be off.** Pitch level counts only beyond a tolerance, and every practice attempt refines the setup, so a poor setup recording corrects itself.

Clips the scorer can't recognize (745 of 9,839, mostly male 4th tones ending in creaky voice) are marked "unreliable" and not used as scoring references. They can still be played.

If a tone keeps scoring wrong for someone, press **⤓ Save** under the result to download that recording, so it can be analyzed.

## Limitations

- Only **tones** are judged. Initials and finals (zh/z, ü/u, -n/-ng, ...) are not checked yet. That would need a speech-recognition model and is a possible next step.
- Neutral tone and multi-syllable words are not covered, since the audio bank has single syllables in tones 1 to 4.

## Running it

### On your Windows computer (no commands needed)

1. On GitHub, open the repository, click the green **Code** button, then **Download ZIP**.
2. Unzip it.
3. Double-click **`Start Tone Coach.bat`**. A small window opens and the app opens in your browser.
4. Allow the microphone when the browser asks. Keep the small window open while practicing; close it to stop.

If Windows shows "Windows protected your PC", click **More info**, then **Run anyway** (this appears for any downloaded script).

### Other ways

The page must be served by a web server: opening `index.html` directly as a file won't work, and browsers only allow the microphone on `https://` or `localhost`. Any static server works, e.g. `python -m http.server 8000`, then open http://localhost:8000.

**For students:** host the folder on any static hosting service. GitHub Pages works for public repositories (or private ones on a paid GitHub plan).

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html`, `css/style.css`, `js/app.js` | The web app |
| `js/pitch.js` | Pitch tracking (YIN) and contour extraction |
| `js/scoring.js` | Comparing contours, scores, and feedback tips |
| `js/recorder.js` | Microphone capture with automatic stop |
| `js/pinyin.js` | Tone marks and pinyin input parsing |
| `audio/` | The reference clips, named `<syllable><tone>_<speaker>_MP3.mp3` (`v` = ü) |
| `data/references.json` | Pre-computed pitch contours of every clip |
| `Start Tone Coach.bat`, `launcher/serve.ps1` | Double-click launcher for Windows |
| `tools/build-references.mjs` | Regenerates `data/references.json` and runs the accuracy test |

If clips are added or replaced, regenerate the data (needs Node.js and ffmpeg):

```bash
node tools/build-references.mjs
```

## Credits

Reference audio: *Tone Perfect: Multimodal Database for Mandarin Chinese*, Michigan State University Libraries. Please check its license terms before publishing the app publicly.
