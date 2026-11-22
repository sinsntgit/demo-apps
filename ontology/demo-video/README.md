# OntoStudio demo video

Scripts that make the product demo video: a headless browser drives the **real application** while a narration plays, and the
frames and the voice are assembled into an MP4 with captions and chapter markers. Nothing is mocked on screen except the AI model
(see "The AI model in the video").

```
python3 run.py          # record every chapter (about 15 minutes)
python3 assemble.py     # build build/out/ontostudio-demo.mp4 (+ .vtt, .srt, chapters.json, poster.jpg)
```

Needs: Python 3.11+ with the app's requirements, Node + Playwright + Chromium, `ffmpeg`, `pdftoppm` (poppler) and, for the built-in
voice, `pico2wave` (`apt-get install libttspico-utils`). Everything it creates goes to `build/` (not committed).

## What is in it

| Chapter | Content |
|---|---|
| 0 | Introduction (slides): what an ontology is, why it is needed, what happens without one |
| 1 | The library, and the pre-built starter ontologies |
| 2 | Creating an ontology from domain, use cases and documents; the AI build with live progress |
| 3 | Overview, explanation, standards |
| 4 | The diagram: viewing, adding a subclass and a relationship, expand / collapse / maximise, versions |
| 5 | Classes and properties, rules, use cases |
| 6 | The test bed: coverage, gaps, proposed changes, test again |
| 7 | Quality checks, the reasoner and its fixes, AI fix proposals and gap review |
| 8 | Data sources: databases or files, profiling, documentation, AI descriptions |
| 9 | The knowledge graph: mapping, build, overview, explorer, query, answers in the test bed, where the data lives, downloads |
| 10 | Documents into the graph: extraction with evidence, rejected claims, merging, accepting |
| 11 | Downloads in standard formats, versions |
| 12 | Folders and access, roles, AI usage, AI models, settings, audit log, appearance, help |
| 13 | Summary (slides) |

## How it works

* `chapters/chNN.js` - one file per chapter. A chapter is a list of **beats**: the sentence that is spoken (`say`) and the
  on-screen actions that happen while it is spoken (`act`). The text is the only source of the narration.
* `dump.js` collects the sentences into `build/narration.json`; `tts.py` turns each into `build/audio/<key>.wav`.
* `record.js` plays a chapter: for each beat the audio length and the actions run together, and the beat ends when both are done.
  Frames are captured as 1920x1080 screenshots about 20 times a second at a fixed, moderate zoom (the page is laid out like a
  1477 px wide desktop and rendered at 1.3x: readable text, **no zooming or panning in the video**). A cursor, click ripples and
  highlight boxes are drawn on the page so the viewer can follow.
* `run.py` starts the app and the demo AI model, and saves the application's state after every chapter, so that any chapter can be
  re-recorded alone: `python3 run.py --only ch06` (it starts from the state ch05 left). `--from ch05` re-records from there,
  `--reseed` starts again from an empty instance.
* `assemble.py` joins frames and audio per chapter (short fades), then the chapters, and writes captions and chapter markers.
* `peek.py ch06` writes a contact sheet of a recorded chapter - a quick way to check what each sentence shows.

## Changing the voice

The built-in voice is SVOX Pico: clear, but synthetic. To use a better voice, make one WAV per sentence named after its key
(see `build/narration.json`, e.g. `ch04.03.wav`) and run

```
python3 tts.py --audio-dir /path/to/wavs     # then:  python3 run.py ; python3 assemble.py
```

The video is timed to whatever audio it is given. A sentence is spoken as written in the chapter file; `tts.py` has a small
pronunciation table (`SAY`) for words the built-in voice reads badly (SPARQL, OWL, ...); captions keep the original text.

## Changing what is said or shown

Edit the sentence or the actions in `chapters/chNN.js`, then re-record that chapter (and the ones after it if what it changes is
used later: chapters build on one another - the ontology made in chapter 2 is used up to chapter 12).
`python3 run.py --only chNN` prints for every beat the audio length and how long the actions took; "actions ran N s past the
narration" means the screen is busy without a voice, "screen idle" means the voice is talking over a still screen - adjust the
sleeps or split / extend the sentence.

## The AI model in the video

No AI service is reachable from where this was built, so the AI steps are answered by the application's **built-in demo model**
(`tests/fake_llm.py`, started with `FAKE_LLM_DELAY=2.2` so that the stages of a build are visible). It returns a fixed retail
ontology for every build, fixed test results, a fixed mapping and fixed extractions - they are scripted, including the
claim that is rejected in chapter 10. Everything the *application* does with those answers - the checks, scoring, merging,
graph building, queries, exports - is real. The model is listed in the app as "Demo model" and prices of 3 / 15 per million
tokens are entered, so the usage dashboard shows illustrative costs.
To record with a real model, add it under Admin > AI models before `python3 run.py`, remove the stand-in from `run.py`, and expect
to adjust the chapter files: the content of a real model's ontology differs (class names used by the actions, such as `Order`,
`Customer`, `Store`, come from the stand-in's retail ontology).

## Files

* `assets/` - the sample shop exports (generated by `gen_assets.py`: fictional customers and products) and three short documents.
* `slides/slides.html` - the animated slides of the introduction and the summary.
* `lib.js` - browser, cursor, highlights, frame capture.
