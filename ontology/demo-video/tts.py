#!/usr/bin/env python3
"""Narration -> audio. Reads build/narration.json (made by dump.js) and writes build/audio/<key>.wav + durations.json.

Default voice: SVOX Pico (US English), installed with `apt-get install libttspico-utils`: clear, but synthetic. To use a better voice,
produce one WAV per sentence named <key>.wav (keys are in build/narration.json, e.g. ch04.03.wav) and run

    python3 tts.py --audio-dir /path/to/your/wavs

then record and assemble again: the video is timed to whatever audio it is given.
"""
import argparse, hashlib, json, re, shutil, subprocess, sys, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / "build"
SPEED = 1.0           # the engine's natural pace (about 145 words a minute); below 1 slows it down, pitch is kept

# How the engine should say things it would otherwise read badly (captions keep the original text).
SAY = [
    (r"\bschema\.org\b", "schema dot org"), (r"\bGS1\b", "G S one"), (r"\bFIBO\b", "F I B O"), (r"\bHL7 FHIR\b", "H L seven fire"),
    (r"\bOntoStudio\b", "Onto Studio"), (r"\bAI\b", "A I"), (r"\bSPARQL\b", "sparkle"), (r"\bR2RML\b", "R two R M L"),
    (r"\bJSON-LD\b", "jay son L D"), (r"\bJSON\b", "jay son"), (r"\bPDF\b", "P D F"), (r"\bCSV\b", "C S V"), (r"\bSQL Server\b", "sequel server"),
    (r"\bMySQL\b", "my sequel"), (r"\bPostgreSQL\b", "postgres Q L"), (r"\bSQL\b", "sequel"), (r"\bHermiT\b", "hermit"),
    (r"\bPowerPoint\b", "Power Point"), (r"\bProtégé\b", "pro tay jay"), (r"\bOpenAI\b", "Open A I"), (r"\bOWL\b", "owl"),
    (r"\bTTL\b", "turtle"), (r"\bURL\b", "U R L"), (r"\bIDs\b", "I D s"), (r"\bID\b", "I D"), (r"\bUI\b", "U I"), (r"\bGDPR\b", "G D P R"),
    (r"\bvs\.?\b", "versus"), (r"&", " and "), (r"—", ", "), (r"–", " to "), (r"\s+-\s+", ", "),
]


def spoken(text: str) -> str:
    for a, b in SAY:
        text = re.sub(a, b, text)
    return re.sub(r"\s+", " ", text).strip()


def duration(path: Path) -> float:
    with wave.open(str(path)) as w:
        return w.getnframes() / w.getframerate()


def pico(text: str, out: Path):
    raw = out.with_suffix(".raw.wav")
    subprocess.run(["pico2wave", "-l", "en-US", "-w", str(raw), spoken(text)], check=True)
    # slower, gently compressed and levelled, 48 kHz mono
    af = f"atempo={SPEED},highpass=f=75,acompressor=threshold=-21dB:ratio=3:attack=5:release=70:makeup=3,loudnorm=I=-16:TP=-1.5:LRA=7,aresample=48000"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", af, "-ac", "1", "-c:a", "pcm_s16le", str(out)], check=True)
    raw.unlink()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio-dir", help="use <key>.wav files from this folder instead of the built-in voice")
    ap.add_argument("--only", help="only keys starting with this, e.g. ch04")
    args = ap.parse_args()
    items = json.loads((BUILD / "narration.json").read_text())
    adir = BUILD / "audio"; adir.mkdir(parents=True, exist_ok=True)
    durs = json.loads((adir / "durations.json").read_text()) if (adir / "durations.json").exists() else {}
    for it in items:
        key, wav, stamp = it["key"], adir / f"{it['key']}.wav", adir / f"{it['key']}.txt"
        if args.only and not key.startswith(args.only):
            continue
        if args.audio_dir:
            src = Path(args.audio_dir) / f"{key}.wav"
            if not src.exists():
                sys.exit(f"missing {src}")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(wav)], check=True)
        else:
            sig = hashlib.sha1((spoken(it["say"]) + str(SPEED)).encode()).hexdigest()
            if not (wav.exists() and stamp.exists() and stamp.read_text() == sig):
                pico(it["say"], wav); stamp.write_text(sig)
        durs[key] = round(duration(wav), 3)
    (adir / "durations.json").write_text(json.dumps(durs, indent=1))
    per = {}
    for it in items:
        per[it["chapter"]] = per.get(it["chapter"], 0) + durs.get(it["key"], 0)
    print("narration seconds per chapter:", {k: round(v) for k, v in per.items()}, "| total %.1f min" % (sum(per.values()) / 60))


if __name__ == "__main__":
    main()
