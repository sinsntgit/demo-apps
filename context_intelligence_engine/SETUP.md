# Setup and run instructions

Everything runs locally on one machine: Python, SQLite and a browser. No server, cloud account or internet
connection is needed (only `pip install` needs the internet once).

## 1. Requirements

| Item | Minimum |
|---|---|
| Python | 3.11 or newer (`python --version`) |
| Memory | 4 GB free (8 GB comfortable) |
| Disk | 3 GB free for the 100K build (about 1.6 GB database, 80 MB synthetic file, landed copies) |
| OS | macOS, Linux or Windows 10/11 |
| Browser | Any current Chrome, Edge, Firefox or Safari |

## 2. Get the code

- **Zip:** unzip `context_intelligence_engine.zip` anywhere, then open a terminal in the unzipped folder.
- **Git:** `git clone https://github.com/sinsntgit/demo-apps.git`, `git checkout claude/great-fermat-4qijgr`, then `cd context_intelligence_engine`.
  The branch can also be downloaded from GitHub as a zip: `https://github.com/sinsntgit/demo-apps/archive/refs/heads/claude/great-fermat-4qijgr.zip`
  (you need access to the repository).

## 3. Install (once)

macOS / Linux:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows (PowerShell):
```powershell
py --version
py -3 -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

On Windows use `py` (or `python`), **never `python3`**: `python3` is usually a Microsoft Store shortcut that fails with
"The system cannot find the file specified". If `py --version` fails or shows a version below 3.11, install Python
from https://www.python.org/downloads/windows/ with **"Add python.exe to PATH"** ticked, then switch off the
python/python3 entries under Settings > Apps > Advanced app settings > App execution aliases, and reopen PowerShell.
If PowerShell blocks the activate script, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.
After activation, use `python` for every command in this guide.

## 4. (Optional) Add the real Verizon sample

Copy the export to `sample/verizon_traces_example.jsonl`. It is never committed or shared. Without it, the
engine runs on synthetic data only, and the "Real sample" views are empty.

## 5. Run everything with one command

```bash
python run_all.py
```

This generates 100,000 synthetic sessions (about 10 seconds), builds every stage (about 5 minutes), runs
validation (about 40 seconds) and starts the UI. Open **http://127.0.0.1:8080**. The first page loads can take a
few seconds while the server warms its caches. Stop with Ctrl+C.

The synthetic file is generated **once** (fixed seed, so regenerating gives identical data) and the database is
built **once**: afterwards `python run_all.py` just starts the UI on the existing build, keeping your reviews.

| Option | Effect |
|---|---|
| `python run_all.py --rebuild` | Rebuild the database (keeps card and cluster review decisions) |
| `python run_all.py --rebuild --reset` | Rebuild from scratch, dropping review history |
| `python run_all.py --regenerate --sessions 50000` | Regenerate the synthetic file (needed only to change its size) and rebuild |
| `python run_all.py --regenerate --sessions 20000` | Smaller, faster build for a laptop demo (about 1 minute; the volume gate G9 will then report FAIL, as it checks for 100,000) |
| `python run_all.py --port 9000` | Use another port |

## 6. Or run the steps one by one

```bash
python -m cie.synth --sessions 100000 --seed 7       # synthetic population + ground truth (validation only)
python -m cie.run_pipeline --rebuild                 # ingest -> signals -> episodes -> clusters -> patterns -> scores -> cards -> facts -> search index
python -m cie.validate                               # writes reports/validation.md and .json
python -m cie.server --port 8080                     # the UI
python -m pytest -q                                  # 24 automated tests (about 4 seconds)
```

| Task | Command |
|---|---|
| Overnight batch: process new export files dropped into `landing_inbox/` (already-processed files are skipped by checksum; review decisions are kept) | `python -m cie.run_pipeline --daily --inbox landing_inbox` |
| Weekly cluster refit (cluster ids stay stable) | `python -m cie.run_pipeline --refit` |
| Re-run from one stage, or just one stage | `python -m cie.run_pipeline --from-stage patterns` / `--only cards` |
| Clean rebuild, including card review history | `python -m cie.run_pipeline --rebuild --reset-cards` |
| Regenerate the generated documents | `python -m cie.docs` |

## 7. (Optional) Turn on the Claude tier

Claude is used only to adjudicate low-confidence intents (at most 5% of sessions), with its labels accepted only
when grounded in the transcript and in agreement with the rules.

```bash
pip install anthropic
export ANTHROPIC_API_KEY=...            # Windows PowerShell: $env:ANTHROPIC_API_KEY="..."
python -c "from cie import db; from cie.adapters.llm import Adjudicator; print(Adjudicator(db.connect()).run())"
```

Never commit the key. Results and costs show on the Pipeline page; a run stops itself above $25.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Windows: `Program 'python3.exe' failed to run: The system cannot find the file specified` | Use `py -3 -m venv .venv` (see section 3); `python3` on Windows is a Store shortcut, not Python |
| `ModuleNotFoundError: sklearn` / `yaml` | The virtual environment is not active, or `pip install -r requirements.txt` was skipped |
| `Address already in use` | Another program uses port 8080: `python run_all.py --skip-build --port 9000` |
| First page load is slow | Normal for about 30 seconds after start while caches warm; then pages answer in under 100 ms |
| `no such module: fts5` | Your Python's SQLite lacks full-text search (rare): install Python from python.org or use a conda Python |
| A build step fails part-way | Fix the cause and rerun the same command; every stage is idempotent |
| Out of disk space | Delete `data/cie.sqlite*` and `landing/`, then rebuild |

## 9. What is in the folder

| Path | Contents |
|---|---|
| `cie/` | The engine (one module per stage; see `README.md`) |
| `ui/` | The web UI (plain HTML/JS/CSS, no build step) |
| `taxonomy/` | Intent taxonomy v0 (YAML) |
| `samples/` | 77 scripted synthetic fixture sessions used by the tests |
| `docs/`, `reports/` | Week-1 deliverables and the validation report |
| `tests/` | Automated tests and the draft real-sample gold labels |
| `AGENTS.md` | The build contract: scope, decisions, acceptance gates |
| `data/`, `landing/` | Created when you run it (database, synthetic data, landed raw files); never committed |
