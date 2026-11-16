"""Topographic contour lines for the app background (marching squares over a smooth wavy field)."""
import math


def _field(x, y):
    x, y = x / 300.0, y / 300.0
    return (math.sin(x * 1.3 + 0.6 * math.sin(y * 1.7)) + math.sin(y * 1.1 - 0.5 * math.cos(x * 2.1) + 1.2)
            + 0.6 * math.sin((x + y) * 2.3 + 0.4) + 0.4 * math.cos(x * 3.1 - y * 2.7))


def segments(w=1180, h=760, cell=10):
    """List of ((x1, y1), (x2, y2)) line pieces."""
    nx, ny = w // cell + 2, h // cell + 2
    g = [[_field(i * cell, j * cell) for i in range(nx)] for j in range(ny)]
    table = {1: [(3, 0)], 2: [(0, 1)], 3: [(3, 1)], 4: [(1, 2)], 5: [(3, 2), (0, 1)], 6: [(0, 2)], 7: [(3, 2)],
             8: [(2, 3)], 9: [(0, 2)], 10: [(0, 3), (1, 2)], 11: [(1, 2)], 12: [(1, 3)], 13: [(0, 1)], 14: [(3, 0)]}

    def lerp(a, b, va, vb, lv):
        t = (lv - va) / (vb - va) if vb != va else 0.5
        return a + (b - a) * t
    out = []
    for k in range(14):
        lv = -2.6 + k * 0.4
        for j in range(ny - 1):
            for i in range(nx - 1):
                v = [g[j][i], g[j][i + 1], g[j + 1][i + 1], g[j + 1][i]]
                idx = sum((1 << q) for q in range(4) if v[q] > lv)
                if idx in (0, 15):
                    continue
                x0, y0 = i * cell, j * cell
                e = {0: (lerp(x0, x0 + cell, v[0], v[1], lv), y0),
                     1: (x0 + cell, lerp(y0, y0 + cell, v[1], v[2], lv)),
                     2: (lerp(x0, x0 + cell, v[3], v[2], lv), y0 + cell),
                     3: (x0, lerp(y0, y0 + cell, v[0], v[3], lv))}
                for a, b in table.get(idx, []):
                    out.append((e[a], e[b]))
    return out


def svg(w=1180, h=760, stroke="#1f1f1f"):
    d = "".join("M%d %dL%d %d" % (round(a[0]), round(a[1]), round(b[0]), round(b[1])) for a, b in segments(w, h))
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
            '<path d="%s" fill="none" stroke="%s" stroke-width="1.2" stroke-linecap="round"/></svg>' % (w, h, w, h, d, stroke))


if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    open(os.path.join(here, "electron-app", "renderer", "topo.svg"), "w", encoding="utf8").write(svg(1920, 1200))
