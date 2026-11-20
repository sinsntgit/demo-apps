"""A tiny local narrator for the demo recorder: POST {"text": "..."} to http://127.0.0.1:8777/tts -> {"file": ..., "dur": seconds}.
Speech is cached by (voice, speed, text) in demo/out/vo, so re-recording a chapter never re-synthesises unchanged sentences.
Run with the voice environment:  demo/out/tts/venv/bin/python demo/tts_server.py      (see demo/voice_setup.sh)"""
import hashlib, json, os, re, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro

HERE = Path(__file__).parent; OUT = HERE / "out"; VO = OUT / "vo"; VO.mkdir(parents=True, exist_ok=True)
VOICE = os.environ.get("DEMO_VOICE", "af_heart"); SPEED = float(os.environ.get("DEMO_SPEED", "0.97"))
kokoro = Kokoro(str(OUT / "tts/models/kokoro-v1.0.onnx"), str(OUT / "tts/models/voices-v1.0.bin"))

SAY = [  # how the product's words should be spoken
    (r"\bPostgreSQL\b", "Postgres S Q L"), (r"\bMySQL\b", "My S Q L"), (r"\bSingleStore\b", "Single Store"), (r"\bSQL\b", "S Q L"),
    (r"\bOpenAI\b", "Open A I"), (r"\b2FA\b", "two-factor authentication"), (r"\bCSV\b", "C S V"), (r"\bPDFs?\b", "P D F"),
    (r"\bDDL\b", "D D L"), (r"\bAI\b", "A I"), (r"\bIDs\b", "I Ds"), (r"\bGxP\b", "G x P"), (r"\bTOTP\b", "T O T P"),
    (r"\bPPT\b", "PowerPoint"), (r"\bpotx\b", "P O T X"), (r"\bpptx\b", "P P T X"), (r"\bSAP\b", "S A P"), (r"\bERP\b", "E R P"),
    (r"→", " to "), (r"…", ", "), (r"—", ", "), (r"–", " to "), (r"\s·\s", ", "), (r"＋", "plus "), (r"[✨🔒👥🕒⬇▶✎✓✗]", ""),
]

def spoken(text: str) -> str:
    t = text.replace("**", "").replace("\n", " ")
    for pat, rep in SAY:
        t = re.sub(pat, rep, t)
    return re.sub(r"\s+", " ", t).strip()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        text = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["text"]
        say = spoken(text)
        key = hashlib.sha1(f"{VOICE}|{SPEED}|{say}".encode()).hexdigest()[:16]
        f = VO / f"{key}.wav"
        if not f.exists():
            samples, sr = kokoro.create(say, voice=VOICE, speed=SPEED, lang="en-us")
            sf.write(str(f), samples, sr, subtype="PCM_16")
        info = sf.info(str(f))
        body = json.dumps({"file": str(f), "dur": info.frames / info.samplerate, "spoken": say}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)

if __name__ == "__main__":
    print("narrator ready:", VOICE, SPEED, flush=True)
    HTTPServer(("127.0.0.1", 8777), H).serve_forever()
