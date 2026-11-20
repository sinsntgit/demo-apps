"""Join the recorded chapters into the full video and a short highlights cut, each with the voice-over mixed over
a calm music bed (the music dips whenever the narrator speaks), plus an .srt subtitle file for each.

    python3 demo/assemble.py <output-dir>

Needs demo/out/c*.mp4 (+ .json marks and voice cues) from demo/record_all.sh, the narration wav files in demo/out/vo, and ffmpeg.
Highlights: every chapter may mark `hl-start` / `hl-end`; the cut is widened to whole sentences so the narrator never starts or stops mid-sentence."""
import glob, json, os, subprocess, sys, wave

import numpy as np

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
dest = sys.argv[1] if len(sys.argv) > 1 else OUT
os.makedirs(dest, exist_ok=True)
run = lambda *a: subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
dur = lambda f: float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).decode())

VO_SR = 24000
LEAD = 0.3          # the caption fades in about 0.25 s after a cue is logged; the voice starts with it
CAP = {"c00": 10, "c02": 17, "c03": 15, "c05": 20, "c06": 20, "c08": 17, "c10": 20, "c11": 18, "c12": 18, "c14": 15}   # longest highlight window per chapter (s)
SKIP = {"c04", "c09", "c13"}      # chapters left out of the highlights (they are in the full video)


def read_wav(path):
    with wave.open(path) as w:
        assert w.getframerate() == VO_SR and w.getnchannels() == 1, path
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


def voice_track(cues, total, path):
    """cues: [(absolute start s, wav file)] -> one mono wav the length of the video."""
    buf = np.zeros(int((total + 2) * VO_SR), dtype=np.float32)
    for t, f in cues:
        x = read_wav(f); i = int(t * VO_SR)
        buf[i:i + len(x)] += x[:len(buf) - i]
    with wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(VO_SR)
        w.writeframes((np.clip(buf, -1, 1) * 32767).astype("<i2").tobytes())


def srt(cues, path):
    ts = lambda s: f"{int(s // 3600):02d}:{int(s % 3600 // 60):02d}:{int(s % 60):02d},{int(s % 1 * 1000):03d}"
    with open(path, "w", encoding="utf-8") as f:
        for i, (t, d, text) in enumerate(cues, 1):
            f.write(f"{i}\n{ts(t)} --> {ts(t + d)}\n{text}\n\n")


def mix(video, vtrack, music, out):
    """Voice at full level; the music sits under it and ducks while the narrator speaks."""
    run("ffmpeg", "-y", "-i", video, "-i", music, "-i", vtrack, "-filter_complex",
        "[1:a]volume=0.6[m];[2:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[v1][v2];"
        "[m][v2]sidechaincompress=threshold=0.01:ratio=10:attack=15:release=450[duck];"
        "[duck][v1]amix=inputs=2:duration=first:normalize=0[mix];[mix]loudnorm=I=-16:TP=-1.5:LRA=11[a]",
        "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out)


def plain(t):
    return t.replace("**", "").replace("\n", " ")


chapters = sorted(glob.glob(f"{OUT}/c[0-9][0-9]-*.mp4"))
meta = {p: json.load(open(p[:-4] + ".json")) for p in chapters}
lens = {p: dur(p) for p in chapters}

# ------------------------------------------------------------------ the full video
lst = os.path.join(OUT, "concat.txt")
open(lst, "w").write("".join(f"file '{p}'\n" for p in chapters))
silent = os.path.join(OUT, "full-silent.mp4")
run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", silent)
total = dur(silent)
print(f"full video {total:.1f}s from {len(chapters)} chapters")
cues, subs, t0, chap = [], [], 0.0, []
for p in chapters:
    chap.append((t0, os.path.basename(p)[4:-4]))
    for c in meta[p].get("cues", []):
        cues.append((t0 + c["t"] + LEAD, c["file"])); subs.append((t0 + c["t"] + LEAD, c["dur"], plain(c["text"])))
    t0 += lens[p]
vfull = os.path.join(OUT, "voice-full.wav"); voice_track(cues, total, vfull)
wav = os.path.join(OUT, "music.wav")
run(sys.executable, os.path.join(os.path.dirname(OUT), "music.py"), str(total + 1), wav)
mix(silent, vfull, wav, os.path.join(dest, "AskData-demo-full.mp4"))
srt(subs, os.path.join(dest, "AskData-demo-full.srt"))
print("chapters (for the video description):")
for t, name in chap:
    print(f"  {int(t // 60)}:{int(t % 60):02d}  {name}")

# ------------------------------------------------------------------ highlights: whole sentences only
parts = []
for p in chapters:
    m = {x["name"]: x["t"] for x in meta[p]["marks"]}
    if "hl-start" not in m or "hl-end" not in m or os.path.basename(p)[:3] in SKIP:
        continue
    a, b, cs = m["hl-start"], m["hl-end"], meta[p].get("cues", [])
    for c in cs:                                    # widen to sentence boundaries
        if c["t"] - 0.2 <= a < c["t"] + c["dur"] + LEAD:
            a = max(0, c["t"] - 0.3)
        if c["t"] <= b <= c["t"] + c["dur"] + LEAD + 0.6:
            b = c["t"] + c["dur"] + LEAD + 0.8
    cap = CAP.get(os.path.basename(p)[:3], 99)
    if b - a > cap:                                 # keep to whole sentences inside the cap
        fit = [c for c in cs if c["t"] >= a - 0.1 and c["t"] + c["dur"] + LEAD + 0.8 <= a + cap]
        b = max([c["t"] + c["dur"] + LEAD + 0.8 for c in fit], default=a + cap)
    b = min(b, lens[p])
    parts.append((p, a, b))
hl_total = sum(b - a for _, a, b in parts)
print(f"highlights {hl_total:.1f}s from {len(parts)} clips")
inputs, filt, labels, hl_cues, hl_subs, off = [], [], [], [], [], 0.0
for i, (p, a, b) in enumerate(parts):
    inputs += ["-i", p]; l = b - a
    filt.append(f"[{i}:v]trim={a:.2f}:{b:.2f},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.35,fade=t=out:st={l - 0.35:.2f}:d=0.35[v{i}]")
    labels.append(f"[v{i}]")
    for c in meta[p].get("cues", []):
        if c["t"] >= a - 0.1 and c["t"] + c["dur"] + LEAD <= b + 0.05:
            hl_cues.append((off + c["t"] - a + LEAD, c["file"])); hl_subs.append((off + c["t"] - a + LEAD, c["dur"], plain(c["text"])))
    off += l
filt.append("".join(labels) + f"concat=n={len(parts)}:v=1:a=0[v]")
hl_silent = os.path.join(OUT, "hl-silent.mp4")
run("ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filt), "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
    "-pix_fmt", "yuv420p", hl_silent)
vhl = os.path.join(OUT, "voice-hl.wav"); voice_track(hl_cues, hl_total, vhl)
hlwav = os.path.join(OUT, "music-hl.wav")
run(sys.executable, os.path.join(os.path.dirname(OUT), "music.py"), str(hl_total + 1), hlwav)
mix(hl_silent, vhl, hlwav, os.path.join(dest, "AskData-demo-highlights.mp4"))
srt(hl_subs, os.path.join(dest, "AskData-demo-highlights.srt"))
print("done ->", dest)
