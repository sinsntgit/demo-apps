#!/usr/bin/env python3
"""Clips -> the finished video. For each chapter in build/clips/<id>/timeline.json: frames + narration -> one MP4 with short fades;
then the chapters are joined and written to build/out/ with captions (WebVTT/SRT), chapter markers and a poster image.

    python3 assemble.py [--crf 21] [--only ch00,ch01]
"""
import argparse, json, re, subprocess, wave
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
FPS, SR, FADE = 30, 48000, 0.4


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def chapter_video(tl: dict, out: Path, crf: int):
    """-> (video start time, length in seconds)"""
    frames = tl["frames"]
    t0, t_end = tl["t0"], tl["tEnd"] + 0.25
    vstart = max(frames[0][0], t0 - 0.35)
    # the frame on screen at vstart, then every later one
    first = max((i for i, f in enumerate(frames) if f[0] <= vstart), default=0)
    seq = [(vstart, frames[first][1])] + [(t, f) for t, f in frames[first + 1:] if t < t_end]
    lst = out.with_suffix(".txt")
    with open(lst, "w") as fh:
        for i, (t, f) in enumerate(seq):
            nxt = seq[i + 1][0] if i + 1 < len(seq) else t_end
            fh.write(f"file '{Path(f).resolve()}'\nduration {max(nxt - t, 1 / 120):.5f}\n")
        fh.write(f"file '{Path(seq[-1][1]).resolve()}'\n")
    length = t_end - vstart
    vf = f"fps={FPS},format=yuv420p,fade=t=in:st=0:d={FADE},fade=t=out:st={length - FADE:.3f}:d={FADE}"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-vf", vf, "-t", f"{length:.3f}",
         "-c:v", "libx264", "-preset", "medium", "-crf", str(crf), "-pix_fmt", "yuv420p", "-r", str(FPS), str(out)])
    return vstart, length


def chapter_audio(tl: dict, vstart: float, length: float, out: Path):
    buf = np.zeros(int(length * SR) + SR, dtype=np.float32)
    for b in tl["beats"]:
        with wave.open(str(BUILD / "audio" / f"{b['key']}.wav")) as w:
            assert w.getframerate() == SR and w.getnchannels() == 1
            a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        at = int((b["abs"] - vstart + 0.05) * SR)
        if at < 0:
            a = a[-at:]; at = 0
        n = min(len(a), len(buf) - at); buf[at:at + n] += a[:n]
    buf = buf[:int(length * SR)]
    k = int(FADE * SR); buf[:k] *= np.linspace(0, 1, k); buf[-k:] *= np.linspace(1, 0, k)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((np.clip(buf, -1, 1) * 32767).astype(np.int16).tobytes())


def vtt_time(t: float, srt=False) -> str:
    h, m, s = int(t // 3600), int(t % 3600 // 60), t % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", "," if srt else ".")


def cues(text: str, start: float, dur: float):
    """Split a sentence group into caption lines of at most ~84 characters, timed in proportion to their length."""
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    lines = []
    for p in parts:
        while len(p) > 84:
            cut = p.rfind(", ", 30, 84)
            cut = cut if cut > 0 else p.rfind(" ", 30, 84)
            lines.append(p[:cut + 1].strip()); p = p[cut + 1:].strip()
        lines.append(p)
    merged = []                                       # no tiny cues: join short neighbours
    for x in lines:
        if merged and (len(merged[-1]) < 38 or len(x) < 24) and len(merged[-1]) + 1 + len(x) <= 84:
            merged[-1] += " " + x
        else:
            merged.append(x)
    lines = merged
    total = sum(len(x) for x in lines); t = start
    for x in lines:
        d = dur * len(x) / total
        yield t, t + d, x; t += d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--crf", type=int, default=21)
    ap.add_argument("--only")
    args = ap.parse_args()
    narr = {n["key"]: n["say"] for n in json.loads((BUILD / "narration.json").read_text())}
    ids = sorted(p.parent.name for p in (BUILD / "clips").glob("*/timeline.json"))
    if args.only:
        ids = [i for i in ids if i in args.only.split(",")]
    out = BUILD / "out"; out.mkdir(exist_ok=True)
    seg = BUILD / "seg"; seg.mkdir(exist_ok=True)
    parts, chapters, vtt, srt, offset, n_cue = [], [], ["WEBVTT\n"], [], 0.0, 0
    for cid in ids:
        tl = json.loads((BUILD / "clips" / cid / "timeline.json").read_text())
        mp4, wav, final = seg / f"{cid}-v.mp4", seg / f"{cid}.wav", seg / f"{cid}.mp4"
        vstart, length = chapter_video(tl, mp4, args.crf)
        chapter_audio(tl, vstart, length, wav)
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-i", str(wav), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
             "-shortest", "-movflags", "+faststart", str(final)])
        parts.append(final)
        chapters.append({"id": cid, "n": tl["n"], "title": tl["title"], "start": round(offset, 2), "end": round(offset + length, 2)})
        for b in tl["beats"]:
            for a, z, x in cues(narr[b["key"]], offset + b["abs"] - vstart + 0.05, b["audio"]):
                n_cue += 1
                vtt.append(f"{vtt_time(a)} --> {vtt_time(z)}\n{x}\n")
                srt.append(f"{n_cue}\n{vtt_time(a, True)} --> {vtt_time(z, True)}\n{x}\n")
        offset += length
        print(f"{cid}: {length:6.1f}s")
    lst = seg / "all.txt"; lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    meta = seg / "chapters.ffmeta"
    meta.write_text(";FFMETADATA1\ntitle=OntoStudio demo\n" + "".join(
        f"[CHAPTER]\nTIMEBASE=1/1000\nSTART={int(c['start'] * 1000)}\nEND={int(c['end'] * 1000)}\ntitle={c['title']}\n" for c in chapters))
    final = out / "ontostudio-demo.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(meta), "-map", "0", "-map_metadata", "1", "-map_chapters", "1",
         "-c", "copy", "-movflags", "+faststart", str(final)])
    (out / "ontostudio-demo.vtt").write_text("\n".join(vtt)); (out / "ontostudio-demo.srt").write_text("\n".join(srt))
    (out / "chapters.json").write_text(json.dumps(chapters, indent=1))
    run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "3", "-i", str(final), "-frames:v", "1", "-q:v", "2", str(out / "poster.jpg")])
    mb = final.stat().st_size / 1e6
    print(f"\n{final}  {offset / 60:.1f} min  {mb:.0f} MB")


if __name__ == "__main__":
    main()
