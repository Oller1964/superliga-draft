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
# Lysene er små prikker, der flyttes langs kurverne med <animateMotion>. Det er billigt for browseren:
# kun prikkerne tegnes om, ikke hele baggrunden. Ingen sløringsfiltre.
ud = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice" width="100%" height="100%">',
      '<defs><radialGradient id="skaer"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>']
for i, (d, _, b) in enumerate(valgte):
    ud.append(f'<path id="k{i}" d="{d}"/>')
ud.append('</defs>')
for i, (d, _, b) in enumerate(valgte):
    t = laengde(d) / rng2.uniform(55, 85) / hastighed
    start = -rng2.uniform(0, t)
    baglaens = rng2.random() < 0.5
    retning = ' keyPoints="1;0" keyTimes="0;1" calcMode="linear"' if baglaens else ''
    def bevaeg(forsink):
        return f'<animateMotion dur="{t:.1f}s" begin="{start + forsink:.2f}s" repeatCount="indefinite"{retning}><mpath href="#k{i}"/></animateMotion>'
    # hale: små, svage prikker der ligger lidt bagud
    for j, (r, op) in enumerate([(1.1, .18), (1.4, .3), (1.7, .45)]):
        ud.append(f'<circle r="{r}" fill="#fff" opacity="{op}">{bevaeg(-(3 - j) * 0.18 * 70 / 70)}</circle>')
    ud.append(f'<g>{bevaeg(0)}<circle r="9" fill="url(#skaer)"/><circle r="2.2" fill="#fff"/></g>')
ud.append("</svg>")
navn = sys.argv[3] if len(sys.argv) > 3 else ("topo_lys.svg" if hastighed == 1 else "topo_lys_hurtig.svg")
open(navn, "w").write("".join(ud))
print(navn, len(valgte), "lys,", round(len("".join(ud)) / 1024), "KB")
