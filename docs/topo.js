'use strict';
// Slowly flowing topographic contour lines (marching squares over a drifting wave field).
(() => {
  const cv = document.getElementById('topo');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const CELL = window.innerWidth < 700 ? 26 : 16, LEVELS = 13, FPS = 24, SPEED = 0.00022; // SPEED: field time units per ms (very slow)
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W = 0, H = 0, nx = 0, ny = 0, field = null;

  function resize() {
    W = cv.width = window.innerWidth; H = cv.height = window.innerHeight;
    nx = Math.ceil(W / CELL) + 2; ny = Math.ceil(H / CELL) + 2;
    field = new Float32Array(nx * ny);
  }

  function fill(t) {
    // two slow drifting phases make the lines ripple and glide like water
    const a = t * 0.9, b = t * 0.7, c = t * 1.1;
    for (let j = 0; j < ny; j++) {
      const y = (j * CELL) / 300;
      for (let i = 0; i < nx; i++) {
        const x = (i * CELL) / 300;
        field[j * nx + i] =
          Math.sin(x * 1.3 + 0.6 * Math.sin(y * 1.7 + b) + a) +
          Math.sin(y * 1.1 - 0.5 * Math.cos(x * 2.1 + c) + 1.2 - a * 0.8) +
          0.6 * Math.sin((x + y) * 2.3 + 0.4 + c) +
          0.4 * Math.cos(x * 3.1 - y * 2.7 - b * 1.3);
      }
    }
  }

  const lerp = (a, b, va, vb, lv) => a + (b - a) * ((lv - va) / (vb - va || 1e-6));
  const TABLE = [null, [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 2], [0, 1]], [[0, 2]], [[3, 2]],
    [[2, 3]], [[0, 2]], [[0, 3], [1, 2]], [[1, 2]], [[1, 3]], [[0, 1]], [[3, 0]], null];

  function draw(t) {
    fill(t);
    ctx.clearRect(0, 0, W, H);
    ctx.beginPath();
    for (let k = 0; k < LEVELS; k++) {
      const lv = -2.6 + k * 0.4;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const v0 = field[j * nx + i], v1 = field[j * nx + i + 1], v2 = field[(j + 1) * nx + i + 1], v3 = field[(j + 1) * nx + i];
          const idx = (v0 > lv ? 1 : 0) | (v1 > lv ? 2 : 0) | (v2 > lv ? 4 : 0) | (v3 > lv ? 8 : 0);
          const segs = TABLE[idx];
          if (!segs) continue;
          const x0 = i * CELL, y0 = j * CELL;
          const e = [
            [lerp(x0, x0 + CELL, v0, v1, lv), y0],
            [x0 + CELL, lerp(y0, y0 + CELL, v1, v2, lv)],
            [lerp(x0, x0 + CELL, v3, v2, lv), y0 + CELL],
            [x0, lerp(y0, y0 + CELL, v0, v3, lv)],
          ];
          for (const [p, q] of segs) { ctx.moveTo(e[p][0], e[p][1]); ctx.lineTo(e[q][0], e[q][1]); }
        }
      }
    }
    ctx.strokeStyle = '#242424'; ctx.lineWidth = 1.2; ctx.lineCap = 'round'; ctx.stroke();
  }

  resize();
  window.addEventListener('resize', () => { resize(); draw(performance.now() * SPEED); });
  draw(0);
  if (reduce) return;
  let last = 0;
  const frame = (now) => {
    if (!document.hidden && now - last > 1000 / FPS) { last = now; draw(now * SPEED); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
