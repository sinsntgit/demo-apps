"""python3 demo/contact.py <chapter> [frames=12] [cols=3] - tiles evenly spaced frames of demo/out/<chapter>.mp4 into one image."""
import subprocess, sys, os
from PIL import Image
name = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 12; cols = int(sys.argv[3]) if len(sys.argv) > 3 else 3
src = os.path.join(os.path.dirname(__file__), "out", name + ".mp4")
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src]))
tw = 1920 // cols; th = tw * 9 // 16
rows = (n + cols - 1) // cols
sheet = Image.new("RGB", (tw * cols, th * rows))
tmp = "/tmp/claude-0/-home-user-demo-apps/88ed3229-4444-5703-b0fb-282903a74739/scratchpad/cs.png"
for i in range(n):
    t = dur * (i + 0.5) / n
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", src, "-frames:v", "1", "-vf", f"scale={tw}:{th}", tmp], check=True)
    sheet.paste(Image.open(tmp), ((i % cols) * tw, (i // cols) * th))
out = f"/tmp/claude-0/-home-user-demo-apps/88ed3229-4444-5703-b0fb-282903a74739/scratchpad/sheet-{name}.png"
sheet.save(out); print(out, f"{dur:.1f}s")
