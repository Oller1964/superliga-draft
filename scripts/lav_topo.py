# Laver et originalt højdekurve-mønster (topografisk kort) som SVG.
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.ndimage import gaussian_filter
rng = np.random.default_rng(7)
W, H, N = 1600, 1000, 400          # svg-størrelse og gitteropløsning
gy, gx = int(N * H / W), N
z = gaussian_filter(rng.normal(size=(gy, gx)), 30) * 3.2
z += gaussian_filter(rng.normal(size=(gy, gx)), 12) * 0.45
z = (z - z.min()) / (z.max() - z.min())
niveauer = np.linspace(0.05, 0.95, 20)
fig = plt.figure(); cs = plt.contour(np.linspace(0, W, gx), np.linspace(0, H, gy), z, levels=niveauer)
stier = []
for i, segs in enumerate(cs.allsegs):
    stiplet = i % 4 == 2
    for seg in segs:
        if len(seg) < 12: continue
        seg = seg[::3]
        d = "M" + " L".join(f"{x:.0f} {y:.0f}" for x, y in seg)
        stier.append((d, stiplet, 1.6 if i % 4 == 0 else 1.1))
plt.close(fig)
def svg(farve):
    ud = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice" fill="none" stroke="{farve}" stroke-linecap="round" stroke-linejoin="round">']
    for d, stiplet, b in stier:
        ud.append(f'<path d="{d}" stroke-width="{b}"' + (' stroke-dasharray="6 7"' if stiplet else "") + "/>")
    return "".join(ud) + "</svg>"
open("topo.svg", "w").write(svg("#ffffff"))
print(len(stier), "kurver,", round(len(svg("#fff")) / 1024), "KB")

# ---- Små lys der kører langs udvalgte kurver ----
import sys
hastighed = float(sys.argv[1]) if len(sys.argv) > 1 else 1.0   # 1 = rigtigt tempo, 3 = tre gange hurtigere
def laengde(d):
    pts = [tuple(map(float, p.strip().lstrip("ML").split())) for p in d.replace("M", "L").split("L") if p.strip()]
    return sum(((pts[i][0]-pts[i-1][0])**2 + (pts[i][1]-pts[i-1][1])**2) ** 0.5 for i in range(1, len(pts)))
kandidater = sorted([s for s in stier if not s[1]], key=lambda s: -laengde(s[0]))
antal = int(sys.argv[2]) if len(sys.argv) > 2 else 14
valgte = kandidater[:antal]
rng2 = np.random.default_rng(3)
ud = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice" fill="none" stroke-linecap="round">',
      '<defs><filter id="glod" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter></defs><style>',
      '.l{animation:koer var(--t) linear infinite;animation-delay:var(--d)} .h{animation:koerh var(--t) linear infinite;animation-delay:var(--d)}',
      '@keyframes koer{from{stroke-dashoffset:1000}to{stroke-dashoffset:0}} @keyframes koerh{from{stroke-dashoffset:946}to{stroke-dashoffset:-54}}',
      '@media (prefers-reduced-motion:reduce){.l,.h{animation:none}}</style>']
for i, (d, _, b) in enumerate(valgte):
    t = laengde(d) / rng2.uniform(55, 85) / hastighed       # sekunder pr. omgang ud fra kurvens længde
    forsink = -rng2.uniform(0, t)
    stil = f'style="--t:{t:.1f}s;--d:{forsink:.1f}s"'
    if rng2.random() < 0.5: d = "M" + " L".join(reversed(d[1:].split(" L")))   # nogle kører den anden vej
    ud.append(f'<path class="l" d="{d}" pathLength="1000" stroke="#ffffff" stroke-width="2" stroke-dasharray="60 940" opacity=".28" {stil}/>')
    ud.append(f'<path class="h" d="{d}" pathLength="1000" stroke="#ffffff" stroke-width="6" stroke-dasharray="6 994" opacity=".9" filter="url(#glod)" {stil}/>')
    ud.append(f'<path class="h" d="{d}" pathLength="1000" stroke="#ffffff" stroke-width="2.2" stroke-dasharray="6 994" {stil}/>')
ud.append("</svg>")
navn = sys.argv[3] if len(sys.argv) > 3 else ("topo_lys.svg" if hastighed == 1 else "topo_lys_hurtig.svg")
open(navn, "w").write("".join(ud))
print(navn, len(valgte), "lys,", round(len("".join(ud)) / 1024), "KB")
