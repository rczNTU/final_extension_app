// ===============================
// MINIMAL CONTENT SCRIPT (P1–P4)
// - Pattern 3/4 use integrated square over real t0..t1
// - Pattern 4 uses alphaScale + meanScale to reduce opacity
// - Keeps storage hydrate + messaging
// - Removes all debug/jitter logging
// ===============================

// ---- Params (defaults; overridden by chrome.storage) ----
let FLICKER_HZ = 40;
let meanAlpha = 0.3;
let CHECKER_SIZE = 8;
let MOD_DEPTH = 0.3;

let currentPattern = 1;

// Pattern 4 tuning
const P4_ALPHA_SCALE = 1; // modulation depth scaling
const P4_MEAN_SCALE  = 1; // base opacity scaling (makes it less opaque)
let p4CycleAccum = 0;
// ---- Runtime ----
let running = false;
let rafId = null;
let lastNowSec = 0;

let phase = 0;    // P2
let acc = 0;      // P1
let squareOn = true;

// ---- Canvas ----
let canvas = null;
let ctx = null;
let dpr = 1;
let img = null, imgW = 0, imgH = 0;
// ---- Pattern4 debug ----
const P4_DEBUG = true;
const P4_LOG_MS = 2000;

let p4Frames = 0;
let p4SignFlips = 0;
let p4LastSign = 0;

let p4M_sum = 0;
let p4M_abs_sum = 0;
let p4M_near1 = 0;     // |M| > 0.9
let p4M_mid = 0;       // 0.1 < |M| <= 0.9
let p4M_near0 = 0;     // |M| <= 0.1

let p4LastLogMs = performance.now();
const P1_DEBUG = true;
const P1_LOG_MS = 2000;
let p1Frames = 0, p1Flips = 0, p1LastLogMs = performance.now();
let p1PrevSquare = null;
let p1CycleAccum = 0;   // true cycles (ground truth)
let p1PrevFrameTime = null;
let p1JitterCount = 0;
const P1_JITTER_THRESH = 0.003; // 3ms deviation
init();
function integratedSineM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const w = 2 * Math.PI * f;
  const denom = w * dt;
  if (denom < 1e-6) return Math.sin(w * t1);

  return (Math.cos(w * t0) - Math.cos(w * t1)) / denom;
}
function init() {
  hydrate(true);
  window.addEventListener("resize", resizeCanvas);
}

function hydrate(shouldStart = false) {
  chrome.storage.local.get(
    ["autoStart", "meanAlpha", "modDepth", "checkerSize", "freq", "currentPattern"],
    (s) => {
      if (typeof s.meanAlpha === "number") meanAlpha = s.meanAlpha;
      if (typeof s.modDepth === "number") MOD_DEPTH = s.modDepth;
      if (typeof s.checkerSize === "number") CHECKER_SIZE = s.checkerSize;
      if (typeof s.freq === "number") FLICKER_HZ = s.freq;
      if (typeof s.currentPattern === "number") currentPattern = s.currentPattern;

      img = null;

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

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// function drawFullScreen(alpha) {
//   ctx.clearRect(0, 0, canvas.width, canvas.height);
//   ctx.globalAlpha = clamp01(alpha);
//   ctx.fillStyle = "white";
//   ctx.fillRect(0, 0, canvas.width, canvas.height);
//   ctx.globalAlpha = 1;
// }
function drawFullScreen(M) {
  // M in [-1, 1]

  const A = MOD_DEPTH; // amplitude (0–0.5 recommended)
  const L = clamp01(0.5 + A * M);  // luminance in [0,1]

  const v = Math.round(L * 255);

  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Checkerboard where alpha is modulated by M in [-1..1]
function drawCheckerboard(M, alphaScale = 1.0, meanScale = 1.0) {
  const w = canvas.width, h = canvas.height;

  if (!img || imgW !== w || imgH !== h) {
    img = ctx.createImageData(w, h);
    imgW = w; imgH = h;
  }

  const data = img.data;
  const scalePx = Math.max(1, Math.floor(CHECKER_SIZE * dpr));
  const m = Math.max(-1, Math.min(1, M));
  const base = meanAlpha * meanScale;

  let k = 0;
  for (let y = 0; y < h; y++) {
    const iy = (y / scalePx) | 0;
    for (let x = 0; x < w; x++) {
      const ix = (x / scalePx) | 0;
      const even = ((ix + iy) & 1) === 0;
      const sgn = even ? +1 : -1;

      const a = clamp01(base + (MOD_DEPTH * alphaScale) * sgn * m);
      const v = even ? 255 : 0;

      data[k++] = v;
      data[k++] = v;
      data[k++] = v;
      data[k++] = (a * 255) | 0;
    }
  }

  ctx.putImageData(img, 0, 0);
}
function drawFullScreenBW(isWhite) {
  ctx.fillStyle = isWhite ? "white" : "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}
// ---- Patterns ----
//BRIGHTNESS IF FIXED FOR P1
function pattern1(dt) {
  acc += dt;

  // ---- ground truth cycles ----
  p1CycleAccum += dt * FLICKER_HZ;

  const half = 1 / (FLICKER_HZ * 2);

  while (acc >= half) {
    acc -= half;
    squareOn = !squareOn;
  }

  return { kind: "fullBW", isWhite: squareOn };
}

function pattern2(dt) {
  phase += 2 * Math.PI * FLICKER_HZ * dt;
  return { kind: "checker", M: Math.sin(phase) };
}

// integrate square wave over [t0, t1]
function integratedSquareM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const period = 1 / f;
  const half = period / 2;

  let phaseLocal = ((t0 % period) + period) % period;
  let remaining = dt;
  let onTime = 0;

  while (remaining > 0) {
    const inPos = phaseLocal < half;
    const nextBoundary = inPos ? half : period;
    const seg = Math.min(remaining, nextBoundary - phaseLocal);
    if (inPos) onTime += seg;

    remaining -= seg;
    phaseLocal += seg;
    if (phaseLocal >= period) phaseLocal -= period;
  }

  return (onTime / dt) * 2 - 1; // [-1..1]
}

function pattern3(t0, t1) {
  return { kind: "checker", M: integratedSquareM(t0, t1, FLICKER_HZ) };
}

// function pattern4(t0, t1) {
//   return {
//     kind: "checker",
//     M: integratedSquareM(t0, t1, FLICKER_HZ),
//     alphaScale: P4_ALPHA_SCALE,
//     meanScale: P4_MEAN_SCALE
//   };
// }
function pattern4(t0, t1) {
  const M = integratedSineM(t0, t1, FLICKER_HZ);

  if (P4_DEBUG) {
    p4Frames++;

    // -------- robust sign detection --------
    const EPS = 1e-6;
    const s = M > EPS ? 1 : (M < -EPS ? -1 : 0);

    if (s !== 0) {
      if (p4LastSign !== 0 && s !== p4LastSign) {
        p4SignFlips++;
      }
      p4LastSign = s;
    }

    // -------- stats --------
    const absM = Math.abs(M);
    p4M_sum += M;
    p4M_abs_sum += absM;

    if (absM > 0.9) p4M_near1++;
    else if (absM > 0.1) p4M_mid++;
    else p4M_near0++;

    // -------- true cycles (ground truth) --------
    p4CycleAccum += (t1 - t0) * FLICKER_HZ;

    const now = performance.now();
    if (now - p4LastLogMs >= P4_LOG_MS) {
      const secs = (now - p4LastLogMs) / 1000;

      const fps = p4Frames / secs;

      // what the rendered signal is doing
      const estHz_sig = p4SignFlips / (2 * secs);

      // what we intended (ground truth)
      const estHz_true = p4CycleAccum / secs;

      const meanM = p4M_sum / p4Frames;
      const meanAbsM = p4M_abs_sum / p4Frames;

      console.log(
        `[P4] fps=${fps.toFixed(1)} | estHz(sig)≈${estHz_sig.toFixed(2)} | estHz(true)≈${estHz_true.toFixed(2)} | ` +
        `meanM=${meanM.toFixed(3)} | mean|M|=${meanAbsM.toFixed(3)} | ` +
        `|M| bins: >0.9 ${(100*p4M_near1/p4Frames).toFixed(0)}% / ` +
        `mid ${(100*p4M_mid/p4Frames).toFixed(0)}% / ` +
        `near0 ${(100*p4M_near0/p4Frames).toFixed(0)}% | ` +
        `alphaScale=${P4_ALPHA_SCALE} meanScale=${P4_MEAN_SCALE} ` +
        `meanAlpha=${meanAlpha} modDepth=${MOD_DEPTH} freq=${FLICKER_HZ}`
      );

      // -------- reset window --------
      p4Frames = 0;
      p4SignFlips = 0;
      p4M_sum = 0;
      p4M_abs_sum = 0;
      p4M_near1 = 0;
      p4M_mid = 0;
      p4M_near0 = 0;
      p4CycleAccum = 0;
      p4LastSign = 0;
      p4LastLogMs = now;
    }
  }

  return {
    kind: "checker",
    M,
    alphaScale: P4_ALPHA_SCALE,
    meanScale: P4_MEAN_SCALE
  };
}

// ---- Main loop ----
function loop(nowMs) {
  if (!running) return;

  const nowSec = nowMs / 1000;
  if (lastNowSec === 0) { lastNowSec = nowSec; rafId = requestAnimationFrame(loop); return; }

  const t0 = lastNowSec;
  const t1 = nowSec;
  const dt = t1 - t0;
  lastNowSec = nowSec;

  let cmd;
  switch (currentPattern) {
    case 1: cmd = pattern1(dt); break;
    case 2: cmd = pattern2(dt); break;
    case 3: cmd = pattern3(t0, t1); break;
    case 4: cmd = pattern4(t0, t1); break;
    default: cmd = pattern1(dt);
  }
  if (P1_DEBUG && currentPattern === 1 && cmd.kind === "fullBW") {
    p1Frames++;

    // ----   actual visible  flicker flips ----
    if (p1PrevSquare !== null && cmd.isWhite !== p1PrevSquare) {
      p1Flips++;
    }
    p1PrevSquare = cmd.isWhite;

    // ---- frame timing ----
    if (p1PrevFrameTime !== null) {
      const frameDt = t1 - p1PrevFrameTime;
      const ideal = 1 / 60;

      if (Math.abs(frameDt - ideal) > P1_JITTER_THRESH) {
        p1JitterCount++;
      }
    }
    p1PrevFrameTime = t1;

    // ---- logging ----
    const now = performance.now();
    if (now - p1LastLogMs >= P1_LOG_MS) {
      const secs = (now - p1LastLogMs) / 1000;

      const fps = p1Frames / secs;

      // what user actually sees
      const estHz_sig = (p1Flips / 2) / secs;

      // what you intended
      const estHz_true = p1CycleAccum / secs;

      const jitterPct = (p1JitterCount / p1Frames) * 100;

      console.log(
        `[P1] fps=${fps.toFixed(1)} | ` +
        `estHz(sig)≈${estHz_sig.toFixed(2)} | ` +
        `estHz(true)≈${estHz_true.toFixed(2)} | ` +
        `jitter=${jitterPct.toFixed(1)}% | freq=${FLICKER_HZ}`
      );

      // ---- reset ----
      p1Frames = 0;
      p1Flips = 0;
      p1CycleAccum = 0;
      p1JitterCount = 0;

      p1PrevSquare = null;
      p1PrevFrameTime = null;
      p1LastLogMs = now;
    }
  }

  if (cmd.kind === "fullBW") {
      drawFullScreenBW(cmd.isWhite);
    } else if (cmd.kind === "full") {
      drawFullScreen(cmd.alpha);
    } else {
      drawCheckerboard(cmd.M, cmd.alphaScale ?? 1.0, cmd.meanScale ?? 1.0);
    }

  rafId = requestAnimationFrame(loop);
}

// ---- Start/Stop ----
function start(pattern = currentPattern) {
  ensureCanvas();
  resizeCanvas();

  currentPattern = pattern;
  console.log(`[START] pattern=${currentPattern} meanAlpha=${meanAlpha} modDepth=${MOD_DEPTH} checkerSize=${CHECKER_SIZE} freq=${FLICKER_HZ}`);
  phase = 0; acc = 0; squareOn = true;

  running = true;
  lastNowSec = 0;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ---- Messaging ----
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "START") {
    chrome.storage.local.set(
      { autoStart: true, currentPattern: msg.pattern || currentPattern },
      () => hydrate(true)
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

    if (typeof msg.modDepth === "number") { MOD_DEPTH = msg.modDepth; img = null; }
    if (typeof msg.checkerSize === "number") { CHECKER_SIZE = msg.checkerSize; img = null; }
    if (typeof msg.freq === "number") FLICKER_HZ = msg.freq;

    chrome.storage.local.set({
      meanAlpha,
      modDepth: MOD_DEPTH,
      checkerSize: CHECKER_SIZE,
      freq: FLICKER_HZ
    });
  }
});