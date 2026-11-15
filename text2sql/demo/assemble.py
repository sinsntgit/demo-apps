"""Join the recorded chapters into the full video (+ music) and a short highlights cut.
    python3 demo/assemble.py <output-dir>
Needs demo/out/c*.mp4 (+ .json marks) from demo/record_all.sh, and ffmpeg."""
import glob, json, os, subprocess, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
dest = sys.argv[1] if len(sys.argv) > 1 else OUT
os.makedirs(dest, exist_ok=True)
run = lambda *a: subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
dur = lambda f: float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).decode())

chapters = sorted(p for p in glob.glob(f"{OUT}/c[0-9][0-9]-*.mp4"))
lst = os.path.join(OUT, "concat.txt")
open(lst, "w").write("".join(f"file '{p}'\n" for p in chapters))
silent = os.path.join(OUT, "full-silent.mp4")
run("ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", silent)
total = dur(silent)
print(f"full video {total:.1f}s from {len(chapters)} chapters")

wav = os.path.join(OUT, "music.wav")
run(sys.executable, os.path.join(os.path.dirname(OUT), "music.py"), str(total + 1), wav)
full = os.path.join(dest, "AskData-demo-full.mp4")
run("ffmpeg", "-y", "-i", silent, "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-af", "loudnorm=I=-20:TP=-2:LRA=7", "-shortest", "-movflags", "+faststart", full)

CAP = {"c02": 28, "c04": 24, "c06": 30, "c08": 18}   # keeps the highlights under 2:20 (X / LinkedIn limits)
# highlights: opening card, each chapter's hl-start..hl-end window (when it has one), closing card
parts, t0 = [], 0.0
for p in chapters:
    d = dur(p); name = os.path.basename(p)[:-4]
    marks = {m["name"]: m["t"] for m in json.load(open(p[:-4] + ".json"))["marks"]}
    if name.startswith("c00"):
        parts.append((p, 0, min(d, 6.5)))
    elif name.startswith("c11"):
        parts.append((p, max(0, d - 6.5), d))
    elif "hl-start" in marks and "hl-end" in marks:
        parts.append((p, marks["hl-start"], min(marks["hl-end"], marks["hl-start"] + CAP.get(name[:3], 99))))
hl_total = sum(b - a for _, a, b in parts)
print(f"highlights {hl_total:.1f}s from {len(parts)} clips")
inputs, filt, labels = [], [], []
for i, (p, a, b) in enumerate(parts):
    inputs += ["-i", p]; l = b - a
    filt.append(f"[{i}:v]trim={a:.2f}:{b:.2f},setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.35,fade=t=out:st={l-0.35:.2f}:d=0.35[v{i}]")
    labels.append(f"[v{i}]")
filt.append("".join(labels) + f"concat=n={len(parts)}:v=1:a=0[v]")
hl_silent = os.path.join(OUT, "hl-silent.mp4")
run("ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filt), "-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
    "-pix_fmt", "yuv420p", hl_silent)
hlwav = os.path.join(OUT, "music-hl.wav")
run(sys.executable, os.path.join(os.path.dirname(OUT), "music.py"), str(hl_total + 1), hlwav)
run("ffmpeg", "-y", "-i", hl_silent, "-i", hlwav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-af", "loudnorm=I=-20:TP=-2:LRA=7", "-shortest", "-movflags", "+faststart", os.path.join(dest, "AskData-demo-highlights.mp4"))
print("done ->", dest)
