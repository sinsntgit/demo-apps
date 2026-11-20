#!/usr/bin/env bash
# One-time set-up of the offline narrator (Kokoro neural text-to-speech, Apache-2.0) in demo/out/tts.
# Needs Python 3.10+, internet access to PyPI and github.com (about 350 MB of model files). Nothing here ships with the product.
set -eu
cd "$(dirname "$0")"; T="$PWD/out/tts"; mkdir -p "$T/models" "$PWD/out/vo"
[ -x "$T/venv/bin/python" ] || { python3 -m venv "$T/venv"; "$T/venv/bin/pip" install -q kokoro-onnx soundfile; }
B=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
[ -s "$T/models/kokoro-v1.0.onnx" ] || curl -sL -o "$T/models/kokoro-v1.0.onnx" "$B/kokoro-v1.0.onnx"
[ -s "$T/models/voices-v1.0.bin" ]  || curl -sL -o "$T/models/voices-v1.0.bin"  "$B/voices-v1.0.bin"
echo "voice ready: $T"
