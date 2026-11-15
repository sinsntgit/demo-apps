"""Generate a calm instrumental bed for the demo video (no samples, no copyright): python3 demo/music.py <seconds> <out.wav>"""
import sys
import numpy as np

SR = 44100
secs = float(sys.argv[1]); out = sys.argv[2]
rng = np.random.default_rng(7)
bpm = 84; beat = 60 / bpm; bar = 4 * beat
n = int(secs * SR); t = np.arange(n) / SR
mix = np.zeros((2, n))

def hz(m): return 440 * 2 ** ((m - 69) / 12)
CHORDS = [(57, 60, 64, 67), (53, 57, 60, 64), (48, 52, 55, 59), (55, 59, 62, 65)]   # Am7 Fmaj7 Cmaj7 G6 (a calm loop)

def add(sig, start, pan=0.0):
    i = int(start * SR); j = min(n, i + len(sig))
    if i >= n: return
    sig = sig[:j - i]
    mix[0, i:j] += sig * (1 - pan) / 2 * 1.4; mix[1, i:j] += sig * (1 + pan) / 2 * 1.4

def pad(notes, dur):
    tt = np.arange(int(dur * SR)) / SR
    s = np.zeros_like(tt)
    for m in notes:
        for det in (-0.07, 0.0, 0.07):
            f = hz(m) * 2 ** (det / 12)
            s += np.sin(2 * np.pi * f * tt) + 0.3 * np.sin(2 * np.pi * 2 * f * tt)
    env = np.minimum(1, tt / (bar * 0.6)) * np.minimum(1, (dur - tt) / (bar * 0.8))
    return s * env * 0.035

def pluck(m, dur=1.6):
    tt = np.arange(int(dur * SR)) / SR
    f = hz(m)
    s = np.sin(2 * np.pi * f * tt) + 0.4 * np.sin(2 * np.pi * 2 * f * tt) * np.exp(-tt * 6) + 0.15 * np.sin(2 * np.pi * 3 * f * tt) * np.exp(-tt * 9)
    return s * np.exp(-tt * 3.2) * np.minimum(1, tt / 0.004) * 0.09

k = 0; pos = 0.0
while pos < secs:
    ch = CHORDS[k % 4]
    add(pad([ch[0] - 12] + list(ch[1:]), bar * 1.25), pos)
    add(pad([ch[0] - 24], bar * 1.1) * 1.6, pos)
    if pos > bar * 4:                                       # arpeggio enters after four bars
        order = [0, 2, 1, 3, 2, 1, 3, 2]
        for s, idx in enumerate(order):
            if rng.random() < 0.85:
                add(pluck(ch[idx] + 12), pos + s * beat / 2, pan=(-0.4 if s % 2 else 0.4))
    k += 1; pos += bar

# convolution reverb (synthetic decaying noise), applied to a copy mixed back in
irn = int(2.2 * SR); ir = rng.standard_normal((2, irn)) * np.exp(-np.arange(irn) / SR * 2.6)
def conv(x, h):
    L = len(x) + len(h) - 1; N = 1 << (L - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, N) * np.fft.rfft(h, N), N)[:len(x)]
wet = np.stack([conv(mix[c], ir[c]) for c in range(2)])
wet *= np.abs(mix).max() / (np.abs(wet).max() + 1e-9) * 0.55
y = mix * 0.75 + wet
fade = np.minimum(1, t / 3) * np.minimum(1, (secs - t) / 5)
y *= fade
y = y / np.abs(y).max() * 0.8
import wave
pcm = (y.T * 32767).astype("<i2")
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print("music", round(secs), "s ->", out)
