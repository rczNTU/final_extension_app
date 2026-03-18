// ---- Params ----
let FLICKER_HZ = 40;
let meanAlpha = 0.5;
let MOD_DEPTH = 1;
let currentPattern = 1;
let CHECKER_SIZE = 12; // kept for compatibility (unused now)

// ---- Runtime ----
let running = false;
let rafId = null;
let lastNowSec = 0;

let acc = 0;          // pattern1 accumulator
let squareOn = true;  // pattern1 state
let phase = 0;        // kept for compatibility/reset

// ---- Canvas ----
let canvas = null;
let ctx = null;
let dpr = 1;

// ---- Overlay ----
let overlay = null;

// ---- Debug toggles ----
const P4_DEBUG = true;
const P4_LOG_MS = 2000;

let p4Frames = 0;
let p4LastLogMs = performance.now();

const P1_DEBUG = true;
const P1_LOG_MS = 2000;

//p6
let adaptiveBaseLinear = 0.5;  // linear luminance center

let p1Frames = 0;
let p1Flips = 0;
let p1LastLogMs = performance.now();
let p1PrevSquare = null;
let p1PrevFrameTime = null;
let p1JitterCount = 0;
let p12Frames = 0;
let p12LastLogMs = performance.now();
let p12LastM = null;
let p12ZeroCross = 0;
function debugP12Alpha(alpha, M) {
  const now = performance.now();

  if (!debugP12Alpha.last) {
    debugP12Alpha.last = now;
    return;
  }

  if (now - debugP12Alpha.last > 1000) { // 1 second interval
    console.log(
      `[P12-alpha] α=${alpha.toFixed(3)} | M=${M.toFixed(3)}`
    );
    debugP12Alpha.last = now;
  }
}
function debugPattern12(M) {
  p12Frames++;

  // Detect zero crossings (sign change)
  if (p12LastM !== null) {
    if (p12LastM <= 0 && M > 0) {
      p12ZeroCross++;
    }
  }

  p12LastM = M;

  const now = performance.now();
  if (now - p12LastLogMs >= 2000) {
    const elapsed = (now - p12LastLogMs) / 1000;

    const fps = p12Frames / elapsed;

    // Each full sine cycle has 1 upward zero-cross
    const measuredHz = p12ZeroCross / elapsed;

    console.log(
      `[P12] fps=${fps.toFixed(1)} | sineHz≈${measuredHz.toFixed(2)} | M=${M.toFixed(3)}`
    );

    p12Frames = 0;
    p12ZeroCross = 0;
    p12LastLogMs = now;
  }
}
const P1_JITTER_THRESH = 0.003; // seconds (3 ms)
const DISPLAY_GAMMA = 2.2;

const DEFAULT_PARAMS = {
  1: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 }, // max contrast
  2: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 },
  3: { meanAlpha: 0.3, modDepth: 0.3, freq: 40, checkerSize: 12 }, // overlay safe
  4: { meanAlpha: 0.5, modDepth: 0.4, freq: 40, checkerSize: 12 },
  5: { meanAlpha: 0.3, modDepth: 0.3, freq: 40, checkerSize: 12 },
  6: { meanAlpha: 0.5, modDepth: 0.1, freq: 40, checkerSize: 12 },
  7: { meanAlpha: 0.5, modDepth: 0.4, freq: 40, checkerSize: 12 },
  8: { meanAlpha: 0.5, modDepth: 1.0, freq: 40, checkerSize: 12 },
  9: { meanAlpha: 0.3, modDepth: 0.2, freq: 40, checkerSize: 12 },
  10: { meanAlpha: 0.5, modDepth: 0.4, freq: 40, checkerSize: 12 },
  11: { meanAlpha: 0.3, modDepth: 0.2, freq: 40, checkerSize: 12 },
  12: { meanAlpha: 0.5, modDepth: 0.9, freq: 40, checkerSize: 12 },
};

// ---- Init ----
init();
let stimLayer = null;

function ensureStimLayer() {

  if (stimLayer) return;

  stimLayer = document.createElement("div");

  Object.assign(stimLayer.style,{
    position:"fixed",
    inset:"0",
    pointerEvents:"none",
    zIndex:"10"   // BELOW fixation UI
  });

  document.body.appendChild(stimLayer);
}
function init() {
  hydrate(true);
  window.addEventListener("resize", resizeCanvas);
}

// ===============================
// Storage / Hydration
// ===============================
function hydrate(shouldStart = false) {
  chrome.storage.local.get(
    ["autoStart", "patternParams", "currentPattern"],
    (s) => {
      currentPattern = s.currentPattern ?? 1;

      const all = s.patternParams || {};

      // ---- INIT missing patterns ----
      let changed = false;

      for (const pid in DEFAULT_PARAMS) {
        if (!all[pid]) {
          all[pid] = { ...DEFAULT_PARAMS[pid] };
          changed = true;
        }
      }

      if (changed) {
        chrome.storage.local.set({ patternParams: all });
        console.log("[INIT] Filled missing pattern defaults");
      }

      const p = all[currentPattern];

      meanAlpha = p.meanAlpha;
      MOD_DEPTH = p.modDepth;
      FLICKER_HZ = p.freq;
      CHECKER_SIZE = p.checkerSize;

      warnIfUnsafe();

      if (shouldStart && s.autoStart) {
        stop();
        start(currentPattern);
      }
    }
  );
}

// ===============================
// Contrast UI
// ===============================
function computeContrast() {
  const pat = currentPattern;

  let min, max, type;

  if (pat === 2 || pat === 4) {
    // luminance
    min = 0.5 - MOD_DEPTH;
    max = 0.5 + MOD_DEPTH;
    type = "Luminance";
  } else if (pat === 3 || pat === 5) {
    // alpha overlay
    min = meanAlpha - MOD_DEPTH;
    max = meanAlpha + MOD_DEPTH;
    type = "Alpha";
  } else {
    return null;
  }

  min = Math.max(0, Math.min(1, min));
  max = Math.max(0, Math.min(1, max));

  const contrast = (max - min) / (max + min || 1e-9);
  return { type, min, max, contrast };
}

let contrastBox = null;

function ensureContrastBox() {
  if (contrastBox) return;

  contrastBox = document.createElement("div");
  Object.assign(contrastBox.style, {
    position: "fixed",
    bottom: "10px",
    left: "10px",
    padding: "8px 10px",
    background: "rgba(0,0,0,0.7)",
    color: "white",
    fontSize: "12px",
    fontFamily: "monospace",
    zIndex: "2147483647",
    pointerEvents: "none",
    whiteSpace: "pre",
  });

  document.body.appendChild(contrastBox);
}

function updateContrastUI() {
  ensureContrastBox();

  const c = computeContrast();
  if (!c) {
    contrastBox.textContent = "";
    return;
  }

  contrastBox.textContent =
    `P${currentPattern} ${c.type}\n` +
    `min=${c.min.toFixed(3)} max=${c.max.toFixed(3)}\n` +
    `Michelson=${c.contrast.toFixed(3)}`;
}

// ===============================
// Param Safety Warnings
// ===============================
function warnIfUnsafe() {
  const pat = currentPattern;
  const lines = [];
  const MARGIN = 0.02;

  // ===============================
  // ALPHA MODULATION (P3, P5)
  // ===============================
  const alphaMin = meanAlpha - MOD_DEPTH;
  const alphaMax = meanAlpha + MOD_DEPTH;

  const alphaBad = alphaMin < 0 || alphaMax > 1;
  const alphaNear = alphaMin < MARGIN || alphaMax > 1 - MARGIN;

  if (pat === 3 || pat === 5 || pat === 6 || pat === 0) {
    if (alphaBad) {
      lines.push(
        `[WARN][ALPHA] CLIPPING: range [${alphaMin.toFixed(3)}, ${alphaMax.toFixed(3)}] ` +
          `→ require MOD_DEPTH ≤ min(meanAlpha, 1 - meanAlpha)`
      );
    } else if (alphaNear) {
      lines.push(
        `[WARN][ALPHA] Near limit: range [${alphaMin.toFixed(3)}, ${alphaMax.toFixed(3)}]`
      );
    }
  }

  // ===============================
  // LUMINANCE MODULATION (P2, P4)
  // ===============================
  const lumMin = 0.5 - MOD_DEPTH;
  const lumMax = 0.5 + MOD_DEPTH;

  const lumBad = lumMin < 0 || lumMax > 1;
  const lumNear = lumMin < MARGIN || lumMax > 1 - MARGIN;

  if (pat === 2 || pat === 4 || pat === 7 || pat === 10 || pat === 0) {
    if (lumBad) {
      lines.push(
        `[WARN][LUMINANCE] CLIPPING: range [${lumMin.toFixed(3)}, ${lumMax.toFixed(3)}] ` +
          `→ require MOD_DEPTH ≤ 0.5`
      );
    } else if (lumNear) {
      lines.push(
        `[WARN][LUMINANCE] Near limit: range [${lumMin.toFixed(3)}, ${lumMax.toFixed(3)}]`
      );
    }
  }

  if (lines.length) {
    for (const l of lines) console.warn(l);
  } else {
    console.log(
      `[OK] Safe | α=${meanAlpha.toFixed(3)} depth=${MOD_DEPTH.toFixed(3)} f=${FLICKER_HZ.toFixed(2)}Hz`
    );
  }
}

// ===============================
// DOM / Canvas / Overlay
// ===============================
function ensureCanvas() {
  if (canvas) return;

  canvas = document.createElement("canvas");
  Object.assign(canvas.style,{
  position:"absolute",
  inset:"0",
  width:"100%",
  height:"100%",
  pointerEvents:"none",
  zIndex:"1",
  background:"transparent",
  mixBlendMode:"normal",
});

  ensureStimLayer();
  stimLayer.appendChild(canvas);
  canvas.style.zIndex = "1"
  ctx = canvas.getContext("2d", { alpha: true });

  resizeCanvas();
}

function resizeCanvas() {
  if (!canvas) return;

  dpr = Math.max(1, window.devicePixelRatio || 1);

  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;

    if ((currentPattern === 11 || currentPattern === 12) && running) {
  initFireflies(w / dpr, h / dpr, 28);
}
  }
}

function ensureOverlay() {
  if (overlay) return;

  overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgb(128,128,128)", // neutral grey
    pointerEvents: "none",
    zIndex: "2",
    opacity: "0",
  });

  ensureStimLayer();
  stimLayer.appendChild(overlay);
}

// ===============================
// Utils
// ===============================
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function gammaEncodeLinear01(L) {
  return Math.pow(clamp01(L), 1 / DISPLAY_GAMMA);
}

function squareWave(t, f) {
  return Math.sin(2 * Math.PI * f * t) >= 0 ? 1 : -1;
}

function integratedSquareM(t0, t1, f, steps = 8) {
  let sum = 0;
  const dt = (t1 - t0) / steps;

  for (let i = 0; i < steps; i++) {
    const t = t0 + dt * (i + 0.5);
    sum += squareWave(t, f);
  }
  return sum / steps; // [-1, 1]
}

function integratedSineM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const w = 2 * Math.PI * f;
  const denom = w * dt;

  if (denom < 1e-6) return Math.sin(w * t1);
  return (Math.cos(w * t0) - Math.cos(w * t1)) / denom; // [-1, 1]
}

// ===============================
// Drawers
// ===============================
function drawBorderChecker(M) {
  if (!ctx || !canvas) return;

  const size = Math.max(2, CHECKER_SIZE * dpr);

  const m = Math.max(-1, Math.min(1, M));
  // const L = clamp01(0.5 + MOD_DEPTH * m);
  const L = clamp01(meanAlpha + MOD_DEPTH * m);
  const encoded = gammaEncodeLinear01(L);
  const v = Math.round(encoded * 255);

  const w = canvas.width;
  const h = canvas.height;

  const border = Math.min(w, h) * 0.02;

  ctx.clearRect(0, 0, w, h);

  for (let y = 0; y < h; y += size) {
    for (let x = 0; x < w; x += size) {

      // FIXED CONDITION
      const inBorder =
        x < border ||
        x + size > w - border ||
        y < border ||
        y + size > h - border;

      if (!inBorder) continue;

      const isWhite = ((x / size + y / size) % 2) === 0;
      const color = isWhite ? v : 255 - v;

      ctx.fillStyle = `rgb(${color}, ${color}, ${color})`;
      ctx.fillRect(x, y, size, size);
    }
  }
}
function drawCheckerboardAlpha(isHigh) {
  if (!ctx || !canvas) return;

  const size = Math.max(2, CHECKER_SIZE * dpr);

  // alpha modulation
  const alpha = clamp01(
    meanAlpha + (isHigh ? MOD_DEPTH : -MOD_DEPTH)
  );

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = alpha;

  for (let y = 0; y < canvas.height; y += size) {
    for (let x = 0; x < canvas.width; x += size) {
      let isWhite = ((x / size + y / size) % 2) === 0;

      // phase reversal
      if (isHigh) isWhite = !isWhite;

      ctx.fillStyle = isWhite ? "white" : "black";
      ctx.fillRect(x, y, size, size);
    }
  }

  ctx.globalAlpha = 1.0;
}
function drawCheckerboard(M) {
  if (!ctx || !canvas) return;

  const size = Math.max(2, CHECKER_SIZE * dpr);

  const m = Math.max(-1, Math.min(1, M));

  // luminance modulation (like pattern4)
  const L = clamp01(0.5 + MOD_DEPTH * m);
  const encoded = gammaEncodeLinear01(L);
  const v = Math.round(encoded * 255);

  for (let y = 0; y < canvas.height; y += size) {
    for (let x = 0; x < canvas.width; x += size) {
      const isWhite = ((x / size + y / size) % 2) === 0;

      const color = isWhite ? v : 255 - v;
      ctx.fillStyle = `rgb(${color}, ${color}, ${color})`;
      ctx.fillRect(x, y, size, size);
    }
  }
}
function drawCheckerboardPhase(isHigh) {
  if (!ctx || !canvas) return;

  const size = Math.max(2, CHECKER_SIZE * dpr);

  for (let y = 0; y < canvas.height; y += size) {
    for (let x = 0; x < canvas.width; x += size) {
      let isWhite = ((x / size + y / size) % 2) === 0;

      // flip polarity
      if (isHigh) isWhite = !isWhite;

      ctx.fillStyle = isWhite ? "white" : "black";
      ctx.fillRect(x, y, size, size);
    }
  }
}
function bgLinearToSRGB(linear) {
  return linear <= 0.0031308
    ? linear * 12.92
    : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

function getComplementaryRGB() {
  try {
    const el = document.body || document.documentElement;
    const style = window.getComputedStyle(el);
    const bg = style.backgroundColor;
    const rgb = bg.match(/\d+/g);
    if (!rgb || rgb.length < 3) return { r: 180, g: 20, b: 20 };

    const r = parseInt(rgb[0]) / 255;
    const g = parseInt(rgb[1]) / 255;
    const b = parseInt(rgb[2]) / 255;

    // Perceived luminance (sRGB approximate)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;

    if (lum < 0.15) {
      // Very dark / black page → deep saturated red, less alarming than white
      return { r: 100, g: 20, b: 20 };
    } else if (lum > 0.85) {
      // Very light / white page → deep indigo
      return { r: 40, g: 20, b: 160 };
    } else {
      // Mid-tone → true complementary inversion
      return {
        r: Math.round((1 - r) * 255),
        g: Math.round((1 - g) * 255),
        b: Math.round((1 - b) * 255),
      };
    }
  } catch {
    return { r: 180, g: 20, b: 20 };
  }
}

// Cache it on start so we're not querying DOM every frame
let complementaryColor = { r: 128, g: 128, b: 128 };

function drawAdaptiveOverlay(isHigh) {
  if (!overlay) return;
  const { r, g, b } = complementaryColor;
  overlay.style.background = `rgb(${r},${g},${b})`;
  overlay.style.opacity = isHigh ? (meanAlpha + MOD_DEPTH).toString()
                                 : (meanAlpha - MOD_DEPTH).toString();
}
function drawFullScreenBW(isWhite) {
  if (!ctx || !canvas) return;
  ctx.fillStyle = isWhite ? "white" : "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawOverlayAlpha(M) {
  if (!overlay) return;
  const m = Math.max(-1, Math.min(1, M));
  const alpha = clamp01(meanAlpha + MOD_DEPTH * m);
  overlay.style.opacity = String(alpha);
}

function drawFullScreenLuminance(M) {
  if (!ctx || !canvas) return;

  const m = Math.max(-1, Math.min(1, M));
  const L = clamp01(0.5 + MOD_DEPTH * m);
  const encoded = gammaEncodeLinear01(L);
  const v = Math.round(encoded * 255);

  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ===============================
// Patterns 1–5
// ===============================
function pattern1(dt) {
  acc += dt;

  const halfPeriod = 1 / (2 * FLICKER_HZ);

  while (acc >= halfPeriod) {
    acc -= halfPeriod;
    squareOn = !squareOn;
  }

  return { kind: "fullBW", isWhite: squareOn };
}

function pattern2(t0, t1) {
  return { kind: "brightness", M: integratedSquareM(t0, t1, FLICKER_HZ) };
}

function pattern3(t0, t1) {
  return { kind: "overlayAlpha", M: integratedSquareM(t0, t1, FLICKER_HZ) };
}

function pattern4(t0, t1) {
  return { kind: "brightness", M: integratedSineM(t0, t1, FLICKER_HZ) };
}

function pattern5(t0, t1) {
  return { kind: "overlayAlpha", M: integratedSineM(t0, t1, FLICKER_HZ) };
}
function pattern6(dt) {
  acc += dt;

  const halfPeriod = 1 / (2 * FLICKER_HZ);

  while (acc >= halfPeriod) {
    acc -= halfPeriod;
    squareOn = !squareOn;
  }

  return { kind: "adaptiveBW", isHigh: squareOn };
}
function pattern7(t0, t1) {
  return { kind: "checker", M: integratedSineM(t0, t1, FLICKER_HZ) };
}

function pattern8(dt) {
  acc += dt;

  const halfPeriod = 1 / (2 * FLICKER_HZ);

  while (acc >= halfPeriod) {
    acc -= halfPeriod;
    squareOn = !squareOn;
  }

  return { kind: "checkerPhase", isHigh: squareOn };
}
function pattern9(dt) {
  acc += dt;

  const halfPeriod = 1 / (2 * FLICKER_HZ);

  while (acc >= halfPeriod) {
    acc -= halfPeriod;
    squareOn = !squareOn;
  }

  return { kind: "checkerAlpha", isHigh: squareOn };
}
function pattern10(t0, t1) {
  return { kind: "borderChecker", M: integratedSineM(t0, t1, FLICKER_HZ) };
}
function pattern11(dt, t1) {
  // Exact P1 accumulator — jitter-compensated, phase-stable
  acc += dt;
  const halfPeriod = 1 / (2 * FLICKER_HZ);
  while (acc >= halfPeriod) {
    acc -= halfPeriod;
    squareOn = !squareOn;
  }
  return { kind: "fireflies", t1 };
}
function pattern12(t0, t1) {
  return {
    kind: "fireflies",
    M: integratedSineM(t0, t1, FLICKER_HZ),
    t1
  };
}

// ===============================
// Debug logging
// ===============================
function logDetectedBackground() {
  try {
    const el = document.body || document.documentElement;
    const style = window.getComputedStyle(el);

    let bg = style.backgroundColor;

    // Walk up DOM if transparent
    let current = el;
    while (
      bg === "rgba(0, 0, 0, 0)" ||
      bg === "transparent"
    ) {
      current = current.parentElement;
      if (!current) break;
      bg = window.getComputedStyle(current).backgroundColor;
    }

    if (!bg) {
      console.log("[BG DETECT] No background found");
      return;
    }

    const rgb = bg.match(/\d+/g);
    if (!rgb || rgb.length < 3) return;

    const r_srgb = parseInt(rgb[0], 10) / 255;
    const g_srgb = parseInt(rgb[1], 10) / 255;
    const b_srgb = parseInt(rgb[2], 10) / 255;

    function toLinear(c) {
      return c <= 0.04045
        ? c / 12.92
        : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    const R = toLinear(r_srgb);
    const G = toLinear(g_srgb);
    const B = toLinear(b_srgb);

    const luminance =
      0.2126 * R +
      0.7152 * G +
      0.0722 * B;

    adaptiveBaseLinear = luminance; // 🔴 STORE GLOBALLY

    const type = luminance < 0.5 ? "DARK" : "LIGHT";

    console.log(
      `[BG DETECT] Raw=${bg} | LinearLum=${luminance.toFixed(4)} | Type=${type}`
    );

    console.log(
      `[BG BASE SET] adaptiveBaseLinear=${adaptiveBaseLinear.toFixed(4)}`
    );

  } catch (e) {
    console.warn("[BG DETECT] Error:", e);
  }
}

function debugPattern1(dt) {
  if (!P1_DEBUG) return;

  p1Frames++;
  if (p1PrevSquare !== null && p1PrevSquare !== squareOn) p1Flips++;
  p1PrevSquare = squareOn;

  if (p1PrevFrameTime !== null) {
    const d = Math.abs(dt - p1PrevFrameTime);
    if (d > P1_JITTER_THRESH) p1JitterCount++;
  }
  p1PrevFrameTime = dt;

  const now = performance.now();
  if (now - p1LastLogMs >= P1_LOG_MS) {
    const elapsedSec = (now - p1LastLogMs) / 1000;
    const fps = p1Frames / elapsedSec;
    const measuredFlipHz = p1Flips / elapsedSec;
    const measuredSquareHz = measuredFlipHz / 2;

    console.log(
      `[P1] fps=${fps.toFixed(1)} | flips/s=${measuredFlipHz.toFixed(2)} ` +
        `| squareHz≈${measuredSquareHz.toFixed(2)} | jitterCount=${p1JitterCount}`
    );

    p1Frames = 0;
    p1Flips = 0;
    p1JitterCount = 0;
    p1LastLogMs = now;
  }
}

function debugPattern4(M, dt) {
  if (!P4_DEBUG) return;

  p4Frames++;

  const now = performance.now();
  if (now - p4LastLogMs >= P4_LOG_MS) {
    const elapsedSec = (now - p4LastLogMs) / 1000;
    const fps = p4Frames / elapsedSec;

    const Lmin = 0.5 - MOD_DEPTH;
    const Lmax = 0.5 + MOD_DEPTH;

    console.log(
      `[P4] fps=${fps.toFixed(1)} ` +
        `| M=${M.toFixed(3)} ` +
        `| Lrange=[${Lmin.toFixed(3)}, ${Lmax.toFixed(3)}] ` +
        `| targetHz=${FLICKER_HZ.toFixed(2)}`
    );

    p4Frames = 0;
    p4LastLogMs = now;
  }
}
//====
// ===============================
// Pattern 11 – Fireflies
// ===============================
let fireflies = [];

function initFireflies(w, h, count = 28) {
  fireflies = [];
  const band = Math.min(w, h) * 0.10;

  for (let i = 0; i < count; i++) {
    let x, y;
    const edge = Math.floor(Math.random() * 4);
    if (edge === 0) { x = Math.random() * w; y = Math.random() * band; }
    else if (edge === 1) { x = Math.random() * w; y = h - Math.random() * band; }
    else if (edge === 2) { x = Math.random() * band; y = Math.random() * h; }
    else               { x = w - Math.random() * band; y = Math.random() * h; }

    fireflies.push({
      x, y,
      vx: (Math.random() - 0.5) * 0.4,
      vy: (Math.random() - 0.5) * 0.4,
      phase: Math.random() * Math.PI * 2,      // envelope phase only
      glowSpeed: 0.3 + Math.random() * 0.7,
      radius: 1.2 + Math.random() * 1.8,
      // radius: 4 + Math.random() * 4,
      hue: 48 + Math.random() * 28,
    });
  }
}

function drawFireflies(t1, M = null)  {
  if (!ctx || !canvas || fireflies.length === 0) return;

  const dw = canvas.width / dpr;
  const dh = canvas.height / dpr;
  const band = Math.min(dw, dh) * 0.10;

  for (const f of fireflies) {
    // Organic drift
    f.vx += (Math.random() - 0.5) * 0.05;
    f.vy += (Math.random() - 0.5) * 0.05;
    f.vx = Math.max(-0.7, Math.min(0.7, f.vx));
    f.vy = Math.max(-0.7, Math.min(0.7, f.vy));
    f.x += f.vx;
    f.y += f.vy;

    // Border confinement
    const tooFarIn =
      f.x > band && f.x < dw - band &&
      f.y > band && f.y < dh - band;
    if (tooFarIn) {
      const dl = f.x, dr = dw - f.x, dt_ = f.y, db = dh - f.y;
      const mn = Math.min(dl, dr, dt_, db);
      if (mn === dl) f.vx -= 0.12;
      else if (mn === dr) f.vx += 0.12;
      else if (mn === dt_) f.vy -= 0.12;
      else f.vy += 0.12;
    }
    f.x = Math.max(1, Math.min(dw - 1, f.x));
    f.y = Math.max(1, Math.min(dh - 1, f.y));

    // Slow envelope — size and shape only, never brightness
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * f.glowSpeed * t1 + f.phase);
    const r = (f.radius + envelope * 3) * dpr;
    const cx = f.x * dpr;
    const cy = f.y * dpr;

    // P1 temporal logic: all fireflies flip together, same frame, same phase
    //The values were chosen to produce large modulation depth (~0.9) while avoiding full disappearance of the stimulus.
    let alpha;
    if (M === null) {
      // Pattern 11 (square)
      alpha = squareOn ? 0.95 : 0.04;
    } else {
      // Pattern 12 (sine)
      alpha = clamp01(0.5 + MOD_DEPTH * M);
    }
    if (M !== null) {
      debugP12Alpha(alpha, M);
    }

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 4);
    grad.addColorStop(0,    `hsla(${f.hue}, 90%, 88%, ${alpha.toFixed(3)})`);
    grad.addColorStop(0.25, `hsla(${f.hue}, 85%, 70%, ${(alpha * 0.6).toFixed(3)})`);
    grad.addColorStop(1,    `hsla(${f.hue}, 70%, 50%, 0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 4, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${f.hue + 20}, 100%, 97%, ${alpha.toFixed(3)})`;
    ctx.fill();
  }
}
// ===============================
// Main Loop
// ===============================
function loop(nowMs) {
  if (!running) return;
  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }


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
    case 2: cmd = pattern2(t0, t1); break;
    case 3: cmd = pattern3(t0, t1); break;
    case 4: cmd = pattern4(t0, t1); break;
    case 5: cmd = pattern5(t0, t1); break;
    case 6: cmd = pattern6(dt); break;
    case 7: cmd = pattern7(t0, t1); break;
    case 8: cmd = pattern8(dt); break;
    case 9: cmd = pattern9(dt); break;
    case 10: cmd = pattern10(t0, t1); break;
    case 11: cmd = pattern11(dt, t1); break;
    case 12: cmd = pattern12(t0, t1); break;
    default: cmd = pattern1(dt); break;
  }

  // Execute draw command
  if (cmd.kind === "fullBW") {
    drawFullScreenBW(cmd.isWhite);
    debugPattern1(dt);
  } else if (cmd.kind === "adaptiveBW") {
drawAdaptiveOverlay(cmd.isHigh);
}
  else if (cmd.kind === "overlayAlpha") {
    drawOverlayAlpha(cmd.M);
  } else if (cmd.kind === "brightness") {
    drawFullScreenLuminance(cmd.M);
    if (currentPattern === 4) debugPattern4(cmd.M, dt);
  } else if (cmd.kind === "checker") {
    drawCheckerboard(cmd.M);
  } else if (cmd.kind === "checkerPhase") {
    drawCheckerboardPhase(cmd.isHigh);
  } else if (cmd.kind === "checkerAlpha") {
    drawCheckerboardAlpha(cmd.isHigh);
  }
  else if (cmd.kind === "borderChecker") {
    drawBorderChecker(cmd.M);
  }
  else if (cmd.kind === "fireflies") {
  drawFireflies(cmd.t1, cmd.M);

  if (currentPattern === 11) debugPattern1(dt);
  if (currentPattern === 12) debugPattern12(cmd.M); 
}

  updateContrastUI();
  rafId = requestAnimationFrame(loop);
}

// ===============================
// Start / Stop
// ===============================
function resetRuntimeState() {
  acc = 0;
  squareOn = true;
  phase = 0;
  lastNowSec = 0;

  // P1 debug
  p1Frames = 0;
  p1Flips = 0;
  p1PrevSquare = null;
  p1PrevFrameTime = null;
  p1JitterCount = 0;
  p1LastLogMs = performance.now();

  // P4 debug
  p4Frames = 0;
  p4LastLogMs = performance.now();
}

function start(pattern = currentPattern) {
  stop();
  logDetectedBackground(); 
  complementaryColor = getComplementaryRGB();
  if (Number(pattern) === 6) {
    console.log(`[P6] Complementary color: rgb(${complementaryColor.r},${complementaryColor.g},${complementaryColor.b})`);
  }
  currentPattern = Number(pattern) || 1;
  warnIfUnsafe();
  if (currentPattern === 11 || currentPattern === 12) {
  ensureCanvas();
  initFireflies(window.innerWidth, window.innerHeight, 100);
}

  const isOverlayPattern =
  currentPattern === 3 ||
  currentPattern === 5 ||
  currentPattern === 6;

  if (isOverlayPattern) {
    ensureOverlay();
    if (overlay) overlay.style.opacity = "0";

    // Clear canvas if exists
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    ensureCanvas();
    if (overlay) overlay.style.opacity = "0";
    if (canvas) canvas.style.mixBlendMode = "normal";
  }

  resetRuntimeState();

  running = true;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;

  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (overlay) overlay.style.opacity = "0";
  if (canvas) canvas.style.mixBlendMode = "normal";

  document.documentElement.style.filter = "";
}

// ===============================
// Messaging
// ===============================
// ===============================
// Keyboard Shortcuts
// ===============================
// ===============================
// Keyboard Shortcuts (Cross-Platform)
// ===============================
document.addEventListener("keydown", (e) => {

  // Avoid triggering while typing
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const ctrl = e.ctrlKey;
  const shift = e.shiftKey;

  if (!ctrl || !shift) return;

  // ---------------------------
  // START
  // Ctrl + Shift + S
  // ---------------------------
  if (e.key.toLowerCase() === "s") {
    console.log("[HOTKEY] START pattern", currentPattern);
    start(currentPattern);
    return;
  }

  // ---------------------------
  // STOP
  // Ctrl + Shift + X
  // ---------------------------
  if (e.key.toLowerCase() === "x") {
    console.log("[HOTKEY] STOP");
    stop();
    return;
  }

  // ---------------------------
  // Pattern switching
  // Ctrl + Shift + 1..9
  // ---------------------------
  const num = parseInt(e.key);

  if (!isNaN(num) && num >= 1 && num <= 9) {
    console.log("[HOTKEY] Pattern", num);

    currentPattern = num;
    resetRuntimeState();
    start(num);
    return;
  }

  // ---------------------------
  // Pattern 10
  // Ctrl + Shift + 0
  // ---------------------------
  if (e.key === "0") {
    console.log("[HOTKEY] Pattern 10");
    currentPattern = 10;
    resetRuntimeState();
    start(10);
    return;
  }

  // ---------------------------
  // Pattern 11
  // Ctrl + Shift + -
  // ---------------------------
  if (e.key === "L") {
    console.log("[HOTKEY] Pattern 11");
    currentPattern = 11;
    resetRuntimeState();
    start(11);
  }

});
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "START") {
    chrome.storage.local.set(
      { autoStart: true, currentPattern: Number(msg.pattern) || currentPattern },
      () => hydrate(true)
    );
    return;
  }

  if (msg.type === "STOP") {
    stop();
    chrome.storage.local.set({ autoStart: false });
    return;
  }

  if (msg.type === "SET_PATTERN") {
    currentPattern = Number(msg.pattern) || 1;

    chrome.storage.local.get(["patternParams"], (s) => {
      const all = s.patternParams || {};
      const p = all[currentPattern] || DEFAULT_PARAMS[currentPattern];

      meanAlpha = p.meanAlpha;
      MOD_DEPTH = p.modDepth;
      FLICKER_HZ = p.freq;
      CHECKER_SIZE = p.checkerSize;

      console.log("[SWITCH] Pattern", currentPattern, p);

      warnIfUnsafe();

      chrome.storage.local.set({ currentPattern });
      resetRuntimeState();
    });

    return;
  }

  if (msg.type === "SET_PARAMS") {
    if (typeof msg.meanAlpha === "number") meanAlpha = msg.meanAlpha;
    if (typeof msg.modDepth === "number") MOD_DEPTH = msg.modDepth;
    if (typeof msg.freq === "number") FLICKER_HZ = msg.freq;
    if (typeof msg.checkerSize === "number") CHECKER_SIZE = msg.checkerSize;

    warnIfUnsafe();

    chrome.storage.local.get(["patternParams"], (s) => {
      const all = s.patternParams || {};

      all[currentPattern] = {
        meanAlpha,
        modDepth: MOD_DEPTH,
        freq: FLICKER_HZ,
        checkerSize: CHECKER_SIZE,
      };

      chrome.storage.local.set({ patternParams: all });
      console.log("[SAVE] Pattern", currentPattern, all[currentPattern]);
    });

    return;
  }

  if (msg.type === "RESET_DEFAULT") {
    const def = DEFAULT_PARAMS[currentPattern];

    meanAlpha = def.meanAlpha;
    MOD_DEPTH = def.modDepth;
    FLICKER_HZ = def.freq;
    CHECKER_SIZE = def.checkerSize;

    warnIfUnsafe();

    chrome.storage.local.get(["patternParams"], (s) => {
      const all = s.patternParams || {};
      all[currentPattern] = { ...def };
      chrome.storage.local.set({ patternParams: all });
    });

    console.log("[RESET] Pattern", currentPattern, def);
    return;
  }
});
// ===============================
// Listen for page messages
// ===============================
window.addEventListener("message", (event) => {

  if (event.source !== window) return

  const msg = event.data
  if (!msg || !msg.type) return

  console.log("[PAGE MESSAGE]", msg)

  if (msg.type === "START_PATTERN") {
    start(currentPattern)
  }

  if (msg.type === "STOP_PATTERN") {
    stop()
  }

  if (msg.type === "SET_PATTERN") {
    currentPattern = Number(msg.pattern) || 1
    resetRuntimeState()
    console.log("[PAGE] Pattern set:", currentPattern)
  }

})