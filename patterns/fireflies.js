// patterns/fireflies.js

// ===============================
// Fireflies Pattern Module
// ===============================

let fireflies = [];

export function initFireflies(width, height, count = 28) {
  fireflies = [];

  const borderBand = Math.min(width, height) * 0.10;

  for (let i = 0; i < count; i++) {
    let x, y;
    const edge = Math.random();

    if (edge < 0.25) {
      x = Math.random() * width;
      y = Math.random() * borderBand;
    } else if (edge < 0.5) {
      x = Math.random() * width;
      y = height - Math.random() * borderBand;
    } else if (edge < 0.75) {
      x = Math.random() * borderBand;
      y = Math.random() * height;
    } else {
      x = width - Math.random() * borderBand;
      y = Math.random() * height;
    }

    fireflies.push({
      x, y,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      phase: Math.random() * Math.PI * 2,
      glowSpeed: 0.4 + Math.random() * 0.8,
      radius: 2.5 + Math.random() * 2.5,
      hue: 50 + Math.random() * 30,
    });
  }
}

export function drawFireflies(ctx, canvas, dpr, t, clamp01) {
  if (!ctx || !canvas) return;

  const w = canvas.width;
  const h = canvas.height;

  const dw = w / dpr;
  const dh = h / dpr;

  const borderBand = Math.min(dw, dh) * 0.10;

  ctx.clearRect(0, 0, w, h);

  for (const f of fireflies) {

    // ---- movement ----
    f.x += f.vx;
    f.y += f.vy;

    f.vx += (Math.random() - 0.5) * 0.04;
    f.vy += (Math.random() - 0.5) * 0.04;

    f.vx = Math.max(-0.6, Math.min(0.6, f.vx));
    f.vy = Math.max(-0.6, Math.min(0.6, f.vy));

    // ---- border constraint ----
    const inBorder =
      f.x < borderBand || f.x > dw - borderBand ||
      f.y < borderBand || f.y > dh - borderBand;

    if (!inBorder) {
      const dl = f.x;
      const dr = dw - f.x;
      const dt_ = f.y;
      const db = dh - f.y;
      const minDist = Math.min(dl, dr, dt_, db);

      if (minDist === dl) f.vx -= 0.1;
      else if (minDist === dr) f.vx += 0.1;
      else if (minDist === dt_) f.vy -= 0.1;
      else f.vy += 0.1;
    }

    // ---- clamp ----
    f.x = Math.max(0, Math.min(dw, f.x));
    f.y = Math.max(0, Math.min(dh, f.y));

    // ---- glow (slow envelope only) ----
    const glow = 0.5 + 0.5 * Math.sin(2 * Math.PI * f.glowSpeed * t + f.phase);
    const alpha = clamp01(0.15 + glow * 0.85);
    const r = (f.radius + glow * 3) * dpr;

    const cx = f.x * dpr;
    const cy = f.y * dpr;

    // ---- gradient glow ----
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3.5);
    grad.addColorStop(0, `hsla(${f.hue}, 90%, 85%, ${alpha})`);
    grad.addColorStop(0.3, `hsla(${f.hue}, 80%, 65%, ${alpha * 0.6})`);
    grad.addColorStop(1, `hsla(${f.hue}, 70%, 50%, 0)`);

    ctx.beginPath();
    ctx.arc(cx, cy, r * 3.5, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    // ---- core ----
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${f.hue + 20}, 100%, 95%, ${alpha})`;
    ctx.fill();
  }
}