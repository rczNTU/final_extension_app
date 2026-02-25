// ---- Params ----
let FLICKER_HZ = 40;
let meanAlpha = 0.3;
let MOD_DEPTH = 0.3;
let currentPattern = 1;

let CHECK_SIZE = 12; // default (8–16 best)
// ---- Pattern 4 (noise checker) ----
let noisePattern = null;
let noiseW = 0;
let noiseH = 0;

// ---- Runtime ----
let running = false;
let rafId = null;
let lastNowSec = 0;

let acc = 0;
let squareOn = true;
let phase = 0;

// ---- Canvas ----
let canvas = null;
let ctx = null;
let dpr = 1;

// ---- Overlay ----
let overlay = null;

// ---- P4 DEBUG ----
const P4_DEBUG = true;
const P4_LOG_MS = 2000;

let p4Frames = 0;
let p4SignFlips = 0;
let p4LastSign = 0;
let p4CycleAccum = 0;
let p4LastLogMs = performance.now();

// ---- P1 DEBUG ----
const P1_DEBUG = true;
const P1_LOG_MS = 2000;

let p1Frames = 0, p1Flips = 0;
let p1LastLogMs = performance.now();
let p1PrevSquare = null;
let p1CycleAccum = 0;
let p1PrevFrameTime = null;
let p1JitterCount = 0;

const P1_JITTER_THRESH = 0.003;

// ---- Init ----
init();
// ===============================
// PARAM SAFETY WARNINGS
// ===============================
function generateNoisePattern() {
  if (!canvas) return;

  const w = Math.ceil(canvas.width / CHECK_SIZE);
  const h = Math.ceil(canvas.height / CHECK_SIZE);

  const total = w * h;
  const arr = new Int8Array(total);

  // fill half +1, half -1
  for (let i = 0; i < total; i++) {
    arr[i] = i < total / 2 ? 1 : -1;
  }

  // shuffle (Fisher-Yates)
  for (let i = total - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }

  noisePattern = arr;
  noiseW = w;
  noiseH = h;
}
function warnIfUnsafe() {
  // Pattern 2: overlay alpha = meanAlpha ± MOD_DEPTH
  const p2Min = meanAlpha - MOD_DEPTH;
  const p2Max = meanAlpha + MOD_DEPTH;
  const p2Bad = (p2Min < 0) || (p2Max > 1);

  // Pattern 4: luminance L = 0.5 ± MOD_DEPTH
  // (your drawFullScreen uses clamp01(0.5 + MOD_DEPTH*m))
  const p4Min = 0.5 - MOD_DEPTH;
  const p4Max = 0.5 + MOD_DEPTH;
  const p4Bad = (p4Min < 0) || (p4Max > 1);

  // General "near clipping" margin (so you get early warning)
  const MARGIN = 0.02;
  const p2Near = (p2Min < MARGIN) || (p2Max > 1 - MARGIN);
  const p4Near = (p4Min < MARGIN) || (p4Max > 1 - MARGIN);

  // Only warn relevant pattern (or warn all if you want)
  const pat = currentPattern;

  const lines = [];

  if (pat === 2 || pat === 0) {
    if (p2Bad) {
      lines.push(
        `[WARN] P2 will CLIP: alpha range [${p2Min.toFixed(3)}, ${p2Max.toFixed(3)}] ` +
        `→ keep MOD_DEPTH <= min(meanAlpha, 1-meanAlpha).`
      );
    } else if (p2Near) {
      lines.push(
        `[WARN] P2 near clipping: alpha range [${p2Min.toFixed(3)}, ${p2Max.toFixed(3)}]`
      );
    }
  }

  if (pat === 4 || pat === 0) {
    if (p4Bad) {
      lines.push(
        `[WARN] P4 will CLIP: L range [${p4Min.toFixed(3)}, ${p4Max.toFixed(3)}] ` +
        `→ keep MOD_DEPTH <= 0.5.`
      );
    } else if (p4Near) {
      lines.push(
        `[WARN] P4 near clipping: L range [${p4Min.toFixed(3)}, ${p4Max.toFixed(3)}]`
      );
    }
  }

  if (lines.length) {
    // Use console.warn so it stands out
    for (const l of lines) console.warn(l);
  } else {
    console.log(
      `[OK] Params safe | meanAlpha=${meanAlpha.toFixed(3)} MOD_DEPTH=${MOD_DEPTH.toFixed(3)}`
    );
  }
}
function init() {
  hydrate(true);
  window.addEventListener("resize", resizeCanvas);
}

function hydrate(shouldStart = false) {
  chrome.storage.local.get(
    ["autoStart", "meanAlpha", "modDepth", "freq", "currentPattern"],
    (s) => {
      if (typeof s.meanAlpha === "number") meanAlpha = s.meanAlpha;
      if (typeof s.modDepth === "number") MOD_DEPTH = s.modDepth;
      if (typeof s.freq === "number") FLICKER_HZ = s.freq;
      if (typeof s.currentPattern === "number") currentPattern = s.currentPattern;
      warnIfUnsafe();

      if (shouldStart && s.autoStart) {
        stop();
        start(currentPattern);
      }
    }
  );
}

// ---- Canvas ----
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

    generateNoisePattern(); 
  }
}

// ---- Overlay ----
function ensureOverlay() {
  if (overlay) return;

  overlay = document.createElement("div");

  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    background: "rgb(128,128,128)", // neutral grey
    pointerEvents: "none",
    zIndex: "2147483646",
    opacity: "0",
  });

  document.documentElement.appendChild(overlay);
}

// ---- Utils ----
function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const DISPLAY_GAMMA = 2.2;

// ---- Drawing ----
function drawOverlayAlpha(M) {
  if (!overlay) return;

  const m = Math.max(-1, Math.min(1, M));
  const alpha = clamp01(meanAlpha + MOD_DEPTH * m);

  overlay.style.opacity = alpha;
}
function drawOverlayLuminance(M) {
  const m = Math.max(-1, Math.min(1, M));

  // small modulation
  const delta = MOD_DEPTH * m;

  // convert to linear luminance
  let L = 0.5 + delta;

  // gamma encode
  const encoded = Math.pow(clamp01(L), 1 / DISPLAY_GAMMA);
  const v = Math.round(encoded * 255);

  // blend using "difference" or additive effect
  ctx.fillStyle = `rgba(${v}, ${v}, ${v}, ${meanAlpha})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawFullScreenBW(isWhite) {
  ctx.fillStyle = isWhite ? "white" : "black";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawFullScreen(M, forceFull = false) {
  const m = Math.max(-1, Math.min(1, M));

  let L;

  if (forceFull) {
    L = (m + 1) * 0.5;
  } else {
    L = clamp01(0.5 + MOD_DEPTH * m);
  }

  const encoded = Math.pow(L, 1 / DISPLAY_GAMMA);
  const v = Math.round(encoded * 255);

  ctx.fillStyle = `rgb(${v}, ${v}, ${v})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

// ---- Signal ----
function integratedSineM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const w = 2 * Math.PI * f;
  const denom = w * dt;

  if (denom < 1e-6) return Math.sin(w * t1);

  return (Math.cos(w * t0) - Math.cos(w * t1)) / denom;
}

// ---- Patterns ----
function pattern1(dt) {
  acc += dt;
  p1CycleAccum += dt * FLICKER_HZ;

  const half = 1 / (FLICKER_HZ * 2);

  while (acc >= half) {
    acc -= half;
    squareOn = !squareOn;
  }

  return { kind: "fullBW", isWhite: squareOn };
}

// function pattern2(dt) {
//   phase += 2 * Math.PI * FLICKER_HZ * dt;
//   if (phase > Math.PI * 2) phase -= Math.PI * 2;

//   return {
//     kind: "overlayAlpha",
//     M: Math.sin(phase)
//   };
// }
function pattern2(t0, t1) {
  const M = integratedSineM(t0, t1, FLICKER_HZ);

  return {
    kind: "overlayAlpha",
    M: M
  };
}

function pattern3(t0,t1) {
  const M = integratedSineM(t0, t1, FLICKER_HZ);
  return {kind: "brightness", M: M };
}
function pattern4(t0, t1) {
  const M = integratedSineM(t0, t1, FLICKER_HZ);
  return { kind: "noise", M };
}
// ---- Loop ----
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
    // case 2: cmd = pattern2(dt); break;
    case 2: cmd = pattern2(t0,t1); break;
    case 3: cmd = pattern3(t0,t1); break;
    case 4: cmd = pattern4(t0, t1); break;
    default: cmd = pattern1(dt);
  }
  if (cmd.kind === "fullBW") {
  drawFullScreenBW(cmd.isWhite);

  } else if (cmd.kind === "overlayAlpha") {
    drawOverlayAlpha(cmd.M);

  } else if (cmd.kind === "brightness") {
    drawBrightness(cmd.M);

  } else if (cmd.kind === "chromatic") {
    drawChromatic(cmd.M);

  } else if (cmd.kind === "full") {
    drawFullScreen(cmd.M, cmd.forceFull);
  }

  rafId = requestAnimationFrame(loop);
}

// ---- Controls ----
function start(pattern = currentPattern) {
  stop();

  currentPattern = pattern;

  if (overlay) overlay.style.opacity = 0;

  if (pattern === 2) {
    ensureOverlay();
    if (canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  } else {
    ensureCanvas();
  }

  acc = 0;
  squareOn = true;
  phase = 0;

  running = true;
  lastNowSec = 0;

  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;

  if (rafId) cancelAnimationFrame(rafId);

  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  if (overlay) {
    overlay.style.opacity = 0;
  }
   document.documentElement.style.filter = "";
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
    if (typeof msg.modDepth === "number") MOD_DEPTH = msg.modDepth;
    if (typeof msg.freq === "number") FLICKER_HZ = msg.freq;

    warnIfUnsafe(); 

    chrome.storage.local.set({
      meanAlpha,
      modDepth: MOD_DEPTH,
      freq: FLICKER_HZ
    });
  }
});