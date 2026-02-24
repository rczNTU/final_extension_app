// ===============================
// MINIMAL CONTENT SCRIPT (P1–P5)
// - Pattern 4 simplified + strengthened
// - Uses integrated sine
// - Full screen luminance (no checkerboard)
// - Pattern 5 = background-aware blended modulation
// ===============================

// ---- Params ----
let FLICKER_HZ = 40;
let meanAlpha = 0.03;
let CHECKER_SIZE = 8;
let MOD_DEPTH = 0.03;

let bgSRGB = { r: 255, g: 255, b: 255 };
let bgLight = { r: 255, g: 255, b: 255 };
let bgDark = { r: 235, g: 235, b: 235 };

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

// ---- Debug ----
const DEBUG = false;
const LOG_EVERY_N = 60;
let frameCount = 0;

init();

// ===============================
// Helpers
// ===============================
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function clampRange(x, lo, hi) {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

function sanitizeMeanAlpha(x) {
  return clampRange(Number(x), 0, 0.1);
}

function sanitizeModDepth(x) {
  return clampRange(Number(x), 0, 0.1);
}

function sanitizeFreq(x) {
  return clampRange(Number(x), 1, 60);
}

function sanitizeCheckerSize(x) {
  return Math.max(1, Math.floor(Number(x) || 1));
}

function linearToSRGB(L) {
  const gamma = 2.2;
  return Math.pow(clamp01(L), 1 / gamma);
}

function integratedSineM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;
  const w = 2 * Math.PI * f;
  return (Math.cos(w * t0) - Math.cos(w * t1)) / (w * dt);
}

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

// ===============================
// Background detection (P5)
// ===============================
function getEffectiveBackgroundColor() {
  const x = Math.floor(window.innerWidth / 2);
  const y = Math.floor(window.innerHeight / 2);
  let el = document.elementFromPoint(x, y);

  while (el) {
    const style = getComputedStyle(el);
    const bg = style.backgroundColor;

    if (
      bg &&
      bg !== "transparent" &&
      bg !== "rgba(0, 0, 0, 0)" &&
      bg !== "rgba(0,0,0,0)"
    ) {
      return bg;
    }

    el = el.parentElement;
  }

  return "rgb(255,255,255)";
}

function updateBackgroundColor() {
  const bg = getEffectiveBackgroundColor();
  const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);

  if (!match) {
    if (DEBUG) console.warn("[BG] Failed to parse:", bg);
    return;
  }

  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);

  bgSRGB = { r, g, b };

  const delta = 20;
  bgLight = {
    r: Math.min(255, r + delta),
    g: Math.min(255, g + delta),
    b: Math.min(255, b + delta),
  };
  bgDark = {
    r: Math.max(0, r - delta),
    g: Math.max(0, g - delta),
    b: Math.max(0, b - delta),
  };

  if (DEBUG) {
    console.log("[BG FIXED]");
    console.log("  picked:", bg);
    console.log("  base:", bgSRGB);
    console.log("  light:", bgLight);
    console.log("  dark:", bgDark);
  }
}

// ===============================
// Init / hydrate
// ===============================
function init() {
  hydrate(true);
  window.addEventListener("resize", resizeCanvas);
}

function hydrate(shouldStart = false) {
  chrome.storage.local.get(
    ["autoStart", "meanAlpha", "modDepth", "checkerSize", "freq", "currentPattern"],
    (s) => {
      if (typeof s.meanAlpha === "number") meanAlpha = sanitizeMeanAlpha(s.meanAlpha);
      if (typeof s.modDepth === "number") MOD_DEPTH = sanitizeModDepth(s.modDepth);
      if (typeof s.checkerSize === "number") CHECKER_SIZE = sanitizeCheckerSize(s.checkerSize);
      if (typeof s.freq === "number") FLICKER_HZ = sanitizeFreq(s.freq);
      if (typeof s.currentPattern === "number") currentPattern = Number(s.currentPattern) || 1;

      img = null;

      if (DEBUG) {
        console.log("[HYDRATE]", {
          meanAlpha,
          MOD_DEPTH,
          CHECKER_SIZE,
          FLICKER_HZ,
          currentPattern,
          autoStart: !!s.autoStart,
          rawStorageMeanAlpha: s.meanAlpha,
          rawStorageModDepth: s.modDepth,
        });
      }

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

// ===============================
// Draw functions
// ===============================
function drawBackgroundModulated(M) {
  const m = Math.max(-1, Math.min(1, M));
  const strength = Math.abs(m);

  // hard cap to prevent accidental opaque overlay even if storage is bad
  const rawAlpha = meanAlpha + MOD_DEPTH * strength;
  const alpha = Math.min(0.08, clamp01(rawAlpha));

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let mode;
  let color;

  if (m >= 0) {
    mode = "lighter";
    color = bgLight;
    ctx.globalCompositeOperation = "lighter";
  } else {
    mode = "multiply";
    color = bgDark;
    ctx.globalCompositeOperation = "multiply";
  }

  ctx.globalAlpha = alpha;
  ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";

  if (DEBUG) {
    frameCount++;
    if (frameCount % LOG_EVERY_N === 0) {
      console.log("[P5 FRAME]");
      console.log("  M:", m.toFixed(3));
      console.log("  strength:", strength.toFixed(3));
      console.log("  rawAlpha:", rawAlpha.toFixed(4));
      console.log("  alpha:", alpha.toFixed(4));
      console.log("  meanAlpha:", meanAlpha);
      console.log("  modDepth:", MOD_DEPTH);
      console.log("  mode:", mode);
      console.log("  color:", color);
    }
  }
}

function drawFullScreen(M) {
  const m = Math.max(-1, Math.min(1, M));

  const maxDepth = Math.min(meanAlpha, 1 - meanAlpha);
  const effectiveDepth = MOD_DEPTH * maxDepth;

  const L = clamp01(meanAlpha + effectiveDepth * m);
  const v = Math.round(linearToSRGB(L) * 255);

  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawAlphaOverlay(M) {
  const m = Math.max(-1, Math.min(1, M));
  const norm = (m + 1) / 2;
  const alpha = clamp01(meanAlpha + MOD_DEPTH * (norm - 0.5));

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;
}

function drawCheckerboard(M) {
  const w = canvas.width, h = canvas.height;

  if (!img || imgW !== w || imgH !== h) {
    img = ctx.createImageData(w, h);
    imgW = w;
    imgH = h;
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

function drawFullScreenBW(isWhite) {
  const m = isWhite ? 1 : -1;

  const maxDepth = Math.min(meanAlpha, 1 - meanAlpha);
  const effectiveDepth = MOD_DEPTH * maxDepth;

  const L = clamp01(meanAlpha + effectiveDepth * m);
  const v = Math.round(linearToSRGB(L) * 255);

  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ===============================
// Patterns
// ===============================
function pattern1(dt) {
  acc += dt;
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

function pattern3(t0, t1) {
  return { kind: "alpha", M: integratedSquareM(t0, t1, FLICKER_HZ) };
}

function pattern4(t0, t1) {
  return { kind: "alpha", M: integratedSineM(t0, t1, FLICKER_HZ) };
}

function pattern5(t0, t1) {
  return { kind: "bg", M: integratedSineM(t0, t1, FLICKER_HZ) };
}

// ===============================
// Main loop
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
    case 5: cmd = pattern5(t0, t1); break;
    default: cmd = pattern1(dt);
  }

  if (cmd.kind === "fullBW") {
    drawFullScreenBW(cmd.isWhite);
  } else if (cmd.kind === "full") {
    drawFullScreen(cmd.M);
  } else if (cmd.kind === "alpha") {
    drawAlphaOverlay(cmd.M);
  } else if (cmd.kind === "bg") {
    drawBackgroundModulated(cmd.M);
  } else {
    drawCheckerboard(cmd.M);
  }

  rafId = requestAnimationFrame(loop);
}

// ===============================
// Start / Stop
// ===============================
function start(pattern = currentPattern) {
  ensureCanvas();
  resizeCanvas();
  updateBackgroundColor();

  currentPattern = pattern;
  phase = 0;
  acc = 0;
  squareOn = true;
  frameCount = 0;

  if (DEBUG) {
    console.log("[START]", {
      pattern: currentPattern,
      freq: FLICKER_HZ,
      meanAlpha,
      modDepth: MOD_DEPTH,
      checkerSize: CHECKER_SIZE,
    });
  }

  running = true;
  lastNowSec = 0;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (DEBUG) console.log("[STOP]");
}

// ===============================
// Messaging
// ===============================
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "START") {
    chrome.storage.local.set(
      { autoStart: true, currentPattern: Number(msg.pattern) || currentPattern },
      () => hydrate(true)
    );
    return;
  }

  if (msg?.type === "STOP") {
    stop();
    chrome.storage.local.set({ autoStart: false });
    return;
  }

  if (msg?.type === "SET_PATTERN") {
    currentPattern = Number(msg.pattern) || 1;
    chrome.storage.local.set({ currentPattern });

    if (DEBUG) console.log("[SET_PATTERN]", currentPattern);
    return;
  }

  if (msg?.type === "SET_PARAMS") {
    if (typeof msg.meanAlpha === "number") meanAlpha = sanitizeMeanAlpha(msg.meanAlpha);
    if (typeof msg.modDepth === "number") MOD_DEPTH = sanitizeModDepth(msg.modDepth);
    if (typeof msg.checkerSize === "number") CHECKER_SIZE = sanitizeCheckerSize(msg.checkerSize);
    if (typeof msg.freq === "number") FLICKER_HZ = sanitizeFreq(msg.freq);

    if (DEBUG) {
      console.log("[PARAM UPDATE]", {
        meanAlpha,
        MOD_DEPTH,
        CHECKER_SIZE,
        FLICKER_HZ,
        rawIncoming: {
          meanAlpha: msg.meanAlpha,
          modDepth: msg.modDepth,
          checkerSize: msg.checkerSize,
          freq: msg.freq,
        }
      });
    }

    chrome.storage.local.set({
      meanAlpha,
      modDepth: MOD_DEPTH,
      checkerSize: CHECKER_SIZE,
      freq: FLICKER_HZ
    });
  }
});