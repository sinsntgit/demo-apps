# Demo video toolkit

Scripted, repeatable recording of the real app (headless Chromium, 1080p) with captions, an on-screen cursor,
a **voice-over** (offline neural text-to-speech) and background music. Nothing here is part of the product and
nothing touches a real data folder: everything runs on throwaway ports and `demo/out/` (git-ignored).

## Rebuild the videos

```bash
demo/voice_setup.sh                                          # once: narrator environment + model files (about 350 MB)
nohup demo/out/tts/venv/bin/python demo/tts_server.py > demo/out/tts.log 2>&1 &    # the narrator, on 127.0.0.1:8777
demo/prepare.sh                                              # fresh stack + seed + snapshot (about 2 minutes)
node demo/prefetch_voice.js                                  # speaks every sentence once, so recording never waits for the narrator
demo/record_all.sh                                           # records every chapter in demo/chapters (restores the snapshot before each)
python3 demo/assemble.py /some/output/folder                 # full video + highlights cut, each with voice, music and an .srt
demo/stack.sh stop
```

Record one chapter while writing it: `demo/reset.sh && node demo/record.js c05-review`.

## How it fits together

| File | What it does |
|---|---|
| `stack.sh`, `prepare.sh`, `reset.sh` | Throwaway app on :8010, stand-in AI model, mail sink, PostgreSQL; seeded state restored between chapters. |
| `seed.py` | Builds the story through the app's own API: people and groups, data models, row filters, a results-only user, two companies with logos, a shared AI model, a report with a schedule, history spread over two weeks. |
| `chapters/cNN-*.js` | One chapter each. `r.say('caption')` shows the caption **and the narrator reads it**; `r.intro(..., vo('text'))` and `r.voice('text')` narrate cards. Keep narration in string literals passed to `say(` / `vo(` so `prefetch_voice.js` finds it. |
| `lib.js` | The recorder: screencast capture, cursor, spotlight ring, cards, `voice()` (logs a cue at the current moment of the video) and `showImage()` for things that happen outside the browser. |
| `tts_server.py`, `voice_setup.sh`, `prefetch_voice.js` | The narrator (Kokoro, Apache-2.0) and its cache in `demo/out/vo`. Voice and pace: `DEMO_VOICE` (default `af_heart`), `DEMO_SPEED` (default `0.97`). Product words are pronounced via the table in `tts_server.py`. |
| `assemble.py` | Places every voice cue on the timeline, ducks the music under it, cuts the highlights at whole sentences, writes subtitles. |
| `music.py` | A synthesised, copyright-free instrumental bed. |

The stand-in AI model (`tests/fake_llm.py`) answers the questions asked in the chapters; the SAP chapter uses the verified
questions of the SAP sample, which it answers verbatim. The videos therefore show the product's behaviour, not the quality of a
real AI model, and say so in the closing card.
