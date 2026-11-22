#!/usr/bin/env python3
"""Record the demo. Each chapter starts from the saved state of the one before, so any chapter can be re-recorded alone.

    python3 run.py                 # all chapters
    python3 run.py --only ch04     # one chapter (needs the state saved by ch03)
    python3 run.py --from ch05     # from here on
    python3 run.py --reseed        # throw the saved states away and start from an empty instance
Needs: node + playwright (+ chromium), ffmpeg, pico2wave, and the app's Python requirements.
"""
import argparse, os, shutil, signal, subprocess, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent
BUILD = ROOT / "build"
DATA, SNAP = BUILD / "data", BUILD / "snap"
PORT, LLM_PORT = 8030, 8765
ORDER = [f"ch{i:02d}" for i in range(14)]
STATELESS = {"ch00", "ch13"}                   # slides: no app state involved


def rmtree(p: Path):
    p = p.resolve()
    assert BUILD.resolve() in p.parents, f"refusing to delete {p}"
    shutil.rmtree(p, ignore_errors=True)


def wait_health(port, tries=80):
    for _ in range(tries):
        try:
            urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=1); return True
        except Exception:
            time.sleep(0.25)
    return False


def start_app():
    env = dict(os.environ, ONTO_DATA_DIR=str(DATA), ONTO_ADMIN_EMAIL="admin@example.com", ONTO_ADMIN_PASSWORD="Admin-Passw0rd!")
    log = open(BUILD / "app.log", "a")
    p = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--port", str(PORT)], cwd=APP, env=env, stdout=log, stderr=log)
    if not wait_health(PORT):
        p.kill(); sys.exit("the app did not start - see build/app.log")
    return p


def stop(p):
    p.send_signal(signal.SIGINT)
    try:
        p.wait(20)
    except subprocess.TimeoutExpired:
        p.kill()
    time.sleep(0.5)


def node(*args):
    return subprocess.run(["node", *args], cwd=ROOT).returncode


def snapshot(name):
    rmtree(SNAP / name); shutil.copytree(DATA, SNAP / name)


def restore(name):
    rmtree(DATA); shutil.copytree(SNAP / name, DATA)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only"); ap.add_argument("--from", dest="start"); ap.add_argument("--reseed", action="store_true")
    a = ap.parse_args()
    BUILD.mkdir(exist_ok=True); SNAP.mkdir(exist_ok=True)
    if node("dump.js") or subprocess.run([sys.executable, "tts.py"], cwd=ROOT).returncode:
        sys.exit("narration failed")
    llm = subprocess.Popen([sys.executable, "-m", "tests.fake_llm"], cwd=APP, env=dict(os.environ, FAKE_LLM_DELAY="2.2"),
                           stdout=open(BUILD / "fake.log", "w"), stderr=subprocess.STDOUT)
    try:
        if not wait_health(8765, 1) and not wait_health_llm():
            sys.exit("the demo model did not start")
        if a.reseed or not (SNAP / "base").exists():
            rmtree(DATA); DATA.mkdir(); app = start_app()
            if node("seed.js"):
                stop(app); sys.exit("seeding failed")
            stop(app); snapshot("base"); print("seeded")
        chain = [c for c in ORDER]
        todo = [a.only] if a.only else [c for c in chain if not a.start or chain.index(c) >= chain.index(a.start)]
        for cid in todo:
            if cid in STATELESS:
                app = start_app()                                   # slides still sign in to the app
                rc = node("record.js", cid); stop(app)
            else:
                prev = max((c for c in chain[:chain.index(cid)] if c not in STATELESS and (SNAP / c).exists()), key=chain.index, default="base")
                restore(prev); app = start_app()
                print(f"--- {cid} (from {prev})")
                rc = node("record.js", cid); stop(app)
                if rc == 0:
                    snapshot(cid)
            if rc:
                sys.exit(f"{cid} failed - see build/clips/{cid}/error-*.png")
    finally:
        llm.terminate()


def wait_health_llm():
    for _ in range(40):
        try:
            urllib.request.urlopen(f"http://localhost:{LLM_PORT}/docs", timeout=1); return True
        except urllib.error.HTTPError:
            return True
        except Exception:
            time.sleep(0.25)
    return False


if __name__ == "__main__":
    main()
