// ===============================
// MINIMAL CONTENT SCRIPT (P1–P4)
// - Pattern 4 simplified + strengthened
// - Uses integrated sine
// - Full screen luminance (no checkerboard)
// ===============================

// ---- Params ----
let FLICKER_HZ = 40;
let meanAlpha = 0.3;
let CHECKER_SIZE = 8;
let MOD_DEPTH = 0.3;

let currentPattern = 1;

// ---- Runtime ----
let running = false;
let rafId = null;
let lastNowSec = 0;

let phase = 0;
let acc = 0;
let squareOn = true;

// ---- Canvas ----
let canvas = null;
let ctx = null;
let dpr = 1;
let img = null, imgW = 0, imgH = 0;

init();

// ===============================
// Integrated sine (KEEP)
// ===============================
function integratedSineM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const w = 2 * Math.PI * f;
  return (Math.cos(w * t0) - Math.cos(w * t1)) / (w * dt);
}

// ===============================
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

// ===============================
// Canvas
// ===============================
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

// ===============================
// DRAW FUNCTIONS
// ===============================

// FULL SCREEN luminance (used by Pattern 4)
function drawFullScreen(M) {
  const m = Math.max(-1, Math.min(1, M));

  // FULL CONTRAST (IMPORTANT)
  const L = 0.5 + 0.5 * m; // 0..1

  const v = Math.round(L * 255);

  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// Checkerboard (unchanged)
function drawCheckerboard(M) {
  const w = canvas.width, h = canvas.height;

  if (!img || imgW !== w || imgH !== h) {
    img = ctx.createImageData(w, h);
    imgW = w; imgH = h;
  }

  const data = img.data;
  const scalePx = Math.max(1, Math.floor(CHECKER_SIZE * dpr));
  const m = Math.max(-1, Math.min(1, M));
  const base = meanAlpha;

  let k = 0;
  for (let y = 0; y < h; y++) {
    const iy = (y / scalePx) | 0;
    for (let x = 0; x < w; x++) {
      const ix = (x / scalePx) | 0;
      const even = ((ix + iy) & 1) === 0;
      const sgn = even ? +1 : -1;

      const a = clamp01(base + MOD_DEPTH * sgn * m);
      const v = even ? 255 : 0;

      data[k++] = v;
      data[k++] = v;
      data[k++] = v;
      data[k++] = (a * 255) | 0;
    }
  }

  ctx.putImageData(img, 0, 0);
}

// Pattern 1 drawing (unchanged)
function drawFullScreenBW(isWhite) {
  ctx.fillStyle = isWhite ? "white" : "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ===============================
// PATTERNS
// ===============================

// Pattern 1 (unchanged)
function pattern1(dt) {
  acc += dt;
  const half = 1 / (FLICKER_HZ * 2);

  while (acc >= half) {
    acc -= half;
    squareOn = !squareOn;
  }

  return { kind: "fullBW", isWhite: squareOn };
}

// Pattern 2 (unchanged)
function pattern2(dt) {
  phase += 2 * Math.PI * FLICKER_HZ * dt;
  return { kind: "checker", M: Math.sin(phase) };
}

// Pattern 3 (unchanged)
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

  return (onTime / dt) * 2 - 1;
}

function pattern3(t0, t1) {
  return { kind: "checker", M: integratedSquareM(t0, t1, FLICKER_HZ) };
}

// ===============================
// NEW SIMPLE STRONG PATTERN 4
// ===============================
function pattern4(t0, t1) {
  const M = integratedSineM(t0, t1, FLICKER_HZ);

  return {
    kind: "full",
    M
  };
}

// ===============================
// MAIN LOOP
// ===============================
function loop(nowMs) {
  if (!running) return;

  const nowSec = nowMs / 1000;
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
    case 1: cmd = pattern1(dt); break;
    case 2: cmd = pattern2(dt); break;
    case 3: cmd = pattern3(t0, t1); break;
    case 4: cmd = pattern4(t0, t1); break;
    default: cmd = pattern1(dt);
  }

  if (cmd.kind === "fullBW") {
    drawFullScreenBW(cmd.isWhite);
  } else if (cmd.kind === "full") {
    drawFullScreen(cmd.M);
  } else {
    drawCheckerboard(cmd.M);
  }

  rafId = requestAnimationFrame(loop);
}

// ===============================
// START / STOP
// ===============================
function start(pattern = currentPattern) {
  ensureCanvas();
  resizeCanvas();

  currentPattern = pattern;
  console.log(`[START] pattern=${currentPattern} freq=${FLICKER_HZ}`);

  phase = 0;
  acc = 0;
  squareOn = true;

  running = true;
  lastNowSec = 0;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// ===============================
// MESSAGING
// ===============================
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
    if (typeof msg.modDepth === "number") MOD_DEPTH = msg.modDepth;
    if (typeof msg.checkerSize === "number") CHECKER_SIZE = msg.checkerSize;
    if (typeof msg.freq === "number") FLICKER_HZ = msg.freq;

    chrome.storage.local.set({
      meanAlpha,
      modDepth: MOD_DEPTH,
      checkerSize: CHECKER_SIZE,
      freq: FLICKER_HZ
    });
  }
});