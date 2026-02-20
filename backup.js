// ===============================
// STRIPPED CONTENT SCRIPT
// Pattern 4 = Pattern 3 style (integrate over real t0..t1)
// Pattern 1/2 kept minimal
// Pattern 5 removed
// Unused color/gamma/background helpers removed
// Keeps your alpha scaling change for Pattern 4
// ===============================

// ---- Params ----
let FLICKER_HZ = 40;
let MEAN_ALPHA = 0;
let CHECKER_SIZE = 8;

// depth of modulation (your slider writes this)
let MOD_DEPTH = 0.08;

// Pattern 4 visibility scale (kept)
const P4_ALPHA_SCALE = 0.05;

// ---- Runtime state ----
let running = false;
let rafId = null;

let currentPattern = 1;
let meanAlpha = MEAN_ALPHA;

let lastNowSec = 0;
let phase = 0;
let acc = 0;
let squareOn = false;

// ---- Debug (kept minimal) ----
const DEBUG = true;
const LOG_EVERY_N = 60;
const JITTER_THRESHOLD = 2;
let frameCount = 0;
let prevFrameMs = null;
let rafJitterEvents = 0;

let p3ZeroCrossings = 0;
let p3LastSign = 0;
let p3WindowStart = performance.now();

let p4ZeroCrossings = 0;
let p4LastSign = 0;
let p4WindowStart = performance.now();

// ---- Canvas ----
let canvas = null;
let ctx = null;
let dpr = 1;
let img = null;
let imgW = 0;
let imgH = 0;

console.log("[CONTENT] injected on", location.href);
hydrateFromStorageAndMaybeStart(true);

function hydrateFromStorageAndMaybeStart(shouldStart = false) {
  chrome.storage.local.get(
    ["autoStart", "meanAlpha", "modDepth", "checkerSize", "freq", "currentPattern"],
    (s) => {
      if (typeof s.meanAlpha === "number") meanAlpha = s.meanAlpha;
      if (typeof s.modDepth === "number") MOD_DEPTH = s.modDepth;
      if (typeof s.checkerSize === "number") CHECKER_SIZE = s.checkerSize;
      if (typeof s.freq === "number") FLICKER_HZ = s.freq;
      if (typeof s.currentPattern === "number") currentPattern = s.currentPattern;

      img = null;

      console.groupCollapsed("[CONTENT] Hydrated state");
      console.log({
        meanAlpha,
        MOD_DEPTH,
        CHECKER_SIZE,
        FLICKER_HZ,
        currentPattern,
        autoStart: s.autoStart
      });
      console.groupEnd();

      if (shouldStart && s.autoStart) {
        stop();
        start(currentPattern);
      }
    }
  );
}

function ensureCanvas() {
  if (canvas) return;

  canvas = document.createElement("canvas");
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "2147483647",
  });

  document.documentElement.appendChild(canvas);
  ctx = canvas.getContext("2d", { alpha: true });
  ctx.imageSmoothingEnabled = false;

  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas) return;
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const w = Math.floor(innerWidth * dpr);
  const h = Math.floor(innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    img = null;
  }
}
window.addEventListener("resize", resizeCanvas);

// ---- Utils ----
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function drawFullScreen(color, alpha) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = clamp01(alpha);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
}

// Checkerboard where alpha is modulated by M in [-1..1]
function drawCheckerboard(M, alphaScale = 1.0, meanScale = 1.0) {
  const w = canvas.width;
  const h = canvas.height;

  if (!img || imgW !== w || imgH !== h) {
    img = ctx.createImageData(w, h);
    imgW = w;
    imgH = h;
  }

  const data = img.data;
  const scalePx = Math.max(1, Math.floor(CHECKER_SIZE * dpr));
  const m = Math.max(-1, Math.min(1, M));

  // NEW: scale the base opacity down (this is what makes it less “claustrophobic”)
  const base = meanAlpha * meanScale;

  let k = 0;
  for (let y = 0; y < h; y++) {
    const iy = (y / scalePx) | 0;
    for (let x = 0; x < w; x++) {
      const ix = (x / scalePx) | 0;
      const even = ((ix + iy) & 1) === 0;
      const sgn = even ? +1 : -1;

      // Use base (scaled mean), NOT meanAlpha
      const a = clamp01(base + (MOD_DEPTH * alphaScale) * sgn * m);

      const v = even ? 255 : 0;
      data[k++] = v;
      data[k++] = v;
      data[k++] = v;
      data[k++] = Math.round(a * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
}

// ---- Patterns ----
function pattern1Update(dt) {
  acc += dt;
  const half = 1 / (FLICKER_HZ * 2);
  while (acc >= half) {
    acc -= half;
    squareOn = !squareOn;
  }
  return {
    kind: "full",
    color: "white",
    alpha: squareOn ? meanAlpha + MOD_DEPTH : meanAlpha - MOD_DEPTH,
  };
}

function pattern2Update(dt) {
  phase += 2 * Math.PI * FLICKER_HZ * dt;
  const M = Math.sin(phase);
  return { kind: "checker", M, alphaScale: 1.0 };
}

// Pattern 3: integrate square wave over actual [t0, t1]
function integratedSquareM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const period = 1 / f;
  const half = period / 2;

  let phaseLocal = ((t0 % period) + period) % period;
  let remaining = dt;
  let onTime = 0;

  while (remaining > 0) {
    const inPositive = phaseLocal < half;
    const nextBoundary = inPositive ? half : period;
    const segment = Math.min(remaining, nextBoundary - phaseLocal);

    if (inPositive) onTime += segment;

    remaining -= segment;
    phaseLocal += segment;
    if (phaseLocal >= period) phaseLocal -= period;
  }

  const fraction = onTime / dt;      // 0..1
  return fraction * 2 - 1;           // -> [-1..1]
}

function pattern3Update(t0, t1) {
  const M = integratedSquareM(t0, t1, FLICKER_HZ);

  if (DEBUG) {
    const s = Math.sign(M);
    if (s !== 0 && s !== p3LastSign) {
      p3ZeroCrossings++;
      p3LastSign = s;
    }
    const now = performance.now();
    if (now - p3WindowStart > 2000) {
      const seconds = (now - p3WindowStart) / 1000;
      const estFreq = (p3ZeroCrossings / 2) / seconds;
      console.log(`[Pattern3 Integrated] estFreq≈${estFreq.toFixed(2)}Hz`);
      p3ZeroCrossings = 0;
      p3WindowStart = now;
    }
  }

  return { kind: "checker", M, alphaScale: 1.0 };
}

// Pattern 4: NOW identical to Pattern 3 math, just with alpha scaling
function pattern4Update(t0, t1) {
  const M = integratedSquareM(t0, t1, FLICKER_HZ);

  if (DEBUG) {
    const s = Math.sign(M);
    if (s !== 0 && s !== p4LastSign) {
      p4ZeroCrossings++;
      p4LastSign = s;
    }
    const now = performance.now();
    if (now - p4WindowStart > 2000) {
      const seconds = (now - p4WindowStart) / 1000;
      const estFreq = (p4ZeroCrossings / 2) / seconds;
      console.log(`[Pattern4 (like P3) Integrated] estFreq≈${estFreq.toFixed(2)}Hz`);
      p4ZeroCrossings = 0;
      p4WindowStart = now;
    }
  }

  return { kind: "checker", M, alphaScale: P4_ALPHA_SCALE, meanScale: 0.05 };
}

// ---- Main loop ----
function loop(now) {
  if (!running) return;

  frameCount++;

  if (prevFrameMs !== null) {
    const dtMs = now - prevFrameMs;
    const ideal = 1000 / 60;
    const deviation = Math.abs(dtMs - ideal);
    if (deviation > JITTER_THRESHOLD) rafJitterEvents++;

    if (DEBUG && frameCount % LOG_EVERY_N === 0) {
      console.log(`[RAF] dt=${dtMs.toFixed(2)}ms | jitterEvents=${rafJitterEvents}`);
      rafJitterEvents = 0;
    }
  }
  prevFrameMs = now;

  const nowSec = now / 1000;

  if (lastNowSec === 0) {
    lastNowSec = nowSec;
    rafId = requestAnimationFrame(loop);
    return;
  }

  const t0 = lastNowSec;
  const t1 = nowSec;
  const dt = t1 - t0;
  lastNowSec = nowSec;

  let cmd;
  switch (currentPattern) {
    case 1: cmd = pattern1Update(dt); break;
    case 2: cmd = pattern2Update(dt); break;
    case 3: cmd = pattern3Update(t0, t1); break;
    case 4: cmd = pattern4Update(t0, t1); break;
    default: cmd = pattern1Update(dt); break;
  }

  if (cmd.kind === "full") {
    drawFullScreen(cmd.color, cmd.alpha);
  } else {
    // drawCheckerboard(cmd.M, cmd.alphaScale ?? 1.0);
    drawCheckerboard(cmd.M, cmd.alphaScale ?? 1.0, cmd.meanScale ?? 1.0);
  }

  rafId = requestAnimationFrame(loop);
}

// ---- Start/Stop ----
function start(pattern = currentPattern) {
  ensureCanvas();
  resizeCanvas();

  currentPattern = pattern;
  phase = 0;
  acc = 0;
  squareOn = true;

  running = true;
  lastNowSec = 0;
  prevFrameMs = null;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg) => {
  console.log("[CONTENT] Message received:", msg);

  if (msg?.type === "START") {
    chrome.storage.local.set(
      { autoStart: true, currentPattern: msg.pattern || currentPattern },
      () => hydrateFromStorageAndMaybeStart(true)
    );
  }

  if (msg?.type === "STOP") {
    stop();
    chrome.storage.local.set({ autoStart: false });
  }

  if (msg?.type === "SET_PATTERN") {
    currentPattern = Number(msg.pattern) || 1;
    chrome.storage.local.set({ currentPattern });
  }

  if (msg?.type === "SET_PARAMS") {
    if (typeof msg.meanAlpha === "number") meanAlpha = msg.meanAlpha;

    if (typeof msg.modDepth === "number") {
      MOD_DEPTH = msg.modDepth;
      img = null;
    }

    if (typeof msg.checkerSize === "number") {
      CHECKER_SIZE = msg.checkerSize;
      img = null;
    }

    if (typeof msg.freq === "number") FLICKER_HZ = msg.freq;

    chrome.storage.local.set({
      meanAlpha,
      modDepth: MOD_DEPTH,
      checkerSize: CHECKER_SIZE,
      freq: FLICKER_HZ
    });
  }
});