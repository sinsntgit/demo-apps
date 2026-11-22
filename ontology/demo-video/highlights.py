#!/usr/bin/env python3
"""A short cut of the demo, made from the footage and narration already recorded (nothing is re-recorded).
Each group below is a run of consecutive sentences; groups are joined with short fades, and a chapter label is added where a
group starts in the middle of a chapter. Writes build/out/ontostudio-demo-highlights.{mp4,vtt,srt}, chapters-highlights.json.

    python3 highlights.py [--crf 21]
Edit SELECTION to change the cut (keys are the ones in build/narration.json).
"""
import argparse, json, re, subprocess, wave
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from assemble import FPS, SR, run, vtt_time, cues

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
SELECTION = [                       # (chapter, first beat, last beat)
    ("ch00", 1, 2),                 # shared words; what an ontology is
    ("ch00", 8, 10),                # three systems, three answers; the impact
    ("ch00", 15, 15),               # what OntoStudio is
    ("ch01", 2, 2),                 # the pre-built library
    ("ch02", 4, 4),                 # building with AI
    ("ch03", 1, 1),                 # the result
    ("ch04", 1, 2),                 # the diagram, adding a subclass
    ("ch06", 3, 3),                 # test bed: coverage, the application's own check
    ("ch06", 5, 5),                 # apply, test again
    ("ch07", 3, 4),                 # the reasoner proposes fixes
    ("ch08", 5, 5),                 # joins, personal data
    ("ch09", 2, 2),                 # mapping, checked
    ("ch09", 5, 6),                 # build, the graph at a glance
    ("ch09", 10, 10),               # answered from the data
    ("ch10", 3, 4),                 # documents: evidence, merging
    ("ch10", 6, 6),                 # records with their sources
    ("ch11", 1, 1),                 # formats
    ("ch13", 2, 2),                 # close
]
FADE = 0.2


def chip_png(n, title, out):
    S = 1.0
    f_b = ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-Bold.otf", 27)
    f_n = ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-Bold.otf", 23)
    w = int(f_b.getlength(title)) + 112
    im = Image.new("RGBA", (w, 64), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, w - 1, 63), 14, fill=(14, 28, 46, 235))
    d.rounded_rectangle((12, 14, 52, 50), 8, fill=(20, 184, 166, 255))
    d.text((32, 32), str(n), font=f_n, fill=(4, 32, 28, 255), anchor="mm")
    d.text((68, 32), title, font=f_b, fill=(255, 255, 255, 255), anchor="lm")
    im.save(out)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--crf", type=int, default=21); args = ap.parse_args()
    narr = {n["key"]: n["say"] for n in json.loads((BUILD / "narration.json").read_text())}
    seg = BUILD / "hl"; seg.mkdir(exist_ok=True)
    parts, vtt, srt, chapters, offset, n_cue, seen = [], ["WEBVTT\n"], [], [], 0.0, 0, set()
    for gi, (cid, a, b) in enumerate(SELECTION):
        tl = json.loads((BUILD / "clips" / cid / "timeline.json").read_text())
        beats = [x for x in tl["beats"] if a <= int(x["key"].split(".")[1]) <= b]
        start, end = beats[0]["abs"], beats[-1]["abs"] + (beats[-1]["end"] - beats[-1]["start"])
        length = end - start
        frames = tl["frames"]
        first = max((i for i, f in enumerate(frames) if f[0] <= start), default=0)
        seq = [(start, frames[first][1])] + [(t, f) for t, f in frames[first + 1:] if t < end]
        lst = seg / f"g{gi:02d}.txt"
        with open(lst, "w") as fh:
            for i, (t, f) in enumerate(seq):
                nxt = seq[i + 1][0] if i + 1 < len(seq) else end
                fh.write(f"file '{Path(f).resolve()}'\nduration {max(nxt - t, 1 / 120):.5f}\n")
            fh.write(f"file '{Path(seq[-1][1]).resolve()}'\n")
        fin = 0.4 if gi == 0 else FADE
        fade = f"fade=t=in:st=0:d={fin},fade=t=out:st={length - FADE:.3f}:d={FADE}"
        label = tl["title"] and not tl["slides"] and a > 1 and cid not in seen
        seen.add(cid)
        mp4, wav, final = seg / f"g{gi:02d}-v.mp4", seg / f"g{gi:02d}.wav", seg / f"g{gi:02d}.mp4"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst)]
        if label:
            chip_png(tl["n"], tl["title"], seg / f"chip{gi:02d}.png")
            cmd += ["-loop", "1", "-t", f"{length:.3f}", "-i", str(seg / f"chip{gi:02d}.png")]
            filt = f"[1:v]format=rgba,fade=t=in:st=0.3:d=0.3:alpha=1,fade=t=out:st=3.6:d=0.3:alpha=1[c];[0:v][c]overlay=36:H-h-36,fps={FPS},format=yuv420p,{fade}[v]"
            cmd += ["-filter_complex", filt, "-map", "[v]"]
        else:
            cmd += ["-vf", f"fps={FPS},format=yuv420p,{fade}"]
        cmd += ["-t", f"{length:.3f}", "-c:v", "libx264", "-preset", "medium", "-crf", str(args.crf), "-pix_fmt", "yuv420p", "-r", str(FPS), str(mp4)]
        run(cmd)
        buf = np.zeros(int(length * SR) + SR, dtype=np.float32)
        for x in beats:
            with wave.open(str(BUILD / "audio" / f"{x['key']}.wav")) as w:
                s = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
            at = int((x["abs"] - start + 0.05) * SR); n = min(len(s), len(buf) - at); buf[at:at + n] += s[:n]
        buf = buf[:int(length * SR)]
        k = int(0.1 * SR); buf[:k] *= np.linspace(0, 1, k); buf[-k:] *= np.linspace(1, 0, k)
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((np.clip(buf, -1, 1) * 32767).astype(np.int16).tobytes())
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-shortest", "-movflags", "+faststart", str(final)])
        parts.append(final)
        for x in beats:
            for ca, cz, text in cues(narr[x["key"]], offset + x["abs"] - start + 0.05, x["audio"]):
                n_cue += 1; vtt.append(f"{vtt_time(ca)} --> {vtt_time(cz)}\n{text}\n"); srt.append(f"{n_cue}\n{vtt_time(ca, True)} --> {vtt_time(cz, True)}\n{text}\n")
        title = tl["title"] if not tl["slides"] or cid == "ch00" else "Summary"
        if chapters and chapters[-1]["title"] == title:
            chapters[-1]["end"] = round(offset + length, 2)
        else:
            chapters.append({"title": title, "start": round(offset, 2), "end": round(offset + length, 2)})
        offset += length
        print(f"{cid}.{a:02d}-{b:02d}  {length:5.1f}s")
    out = BUILD / "out"
    lst = seg / "all.txt"; lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    meta = seg / "chapters.ffmeta"
    meta.write_text(";FFMETADATA1\ntitle=OntoStudio demo - highlights\n" + "".join(
        f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={int(c['start'] * 1000)}\nEND={int(c['end'] * 1000)}\ntitle={c['title']}\n" for c in chapters))
    final = out / "ontostudio-demo-highlights.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(meta), "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", str(final)])
    (out / "ontostudio-demo-highlights.vtt").write_text("\n".join(vtt)); (out / "ontostudio-demo-highlights.srt").write_text("\n".join(srt))
    (out / "chapters-highlights.json").write_text(json.dumps(chapters, indent=1))
    print(f"\n{final}  {offset / 60:.2f} min  {final.stat().st_size / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
