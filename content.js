// ===============================
// Flicker Content Script (Cleaned + Fixed)
// Patterns:
// 1 = Full-screen B/W square wave
// 2 = Full-screen luminance modulation (Andersen interpolated square)
// 3 = Neutral-grey overlay opacity modulation (Andersen interpolated square)
// 4 = Full-screen luminance modulation (integrated sine)
// 5 = Neutral-grey overlay opacity modulation (integrated sine)
// ===============================

// ---- Params ----
let FLICKER_HZ = 40;
let meanAlpha = 0.3;
let MOD_DEPTH = 0.3;
let currentPattern = 1;
let CHECKER_SIZE = 12; // default (8–16 often good)

// ---- Pattern 4 (noise checker) ----
let noisePattern = null;
let noiseW = 0;
let noiseH = 0;
let noiseImageData = null;

// ---- Pattern 6 (phase scheduling) ----
let p6Phase = 0;
let p6Frames = 0;
let p6LastLogMs = performance.now();
let p6SignFlips = 0;
let p6LastSign = 0;
let p6FlipState = 1;   // +1 / -1

const P6_DEBUG = true;
const P6_LOG_MS = 2000;
const metLogger = window.ContrastMetrics?.createContrastRmsLogger({ logMs: 2000 });

// ---- P7 DEBUG ----
const P7_DEBUG = true;
const P7_LOG_MS = 2000;

let p7Frames = 0;
let p7LastLogMs = performance.now();
let p7MaxLeak = 0;
let p7MinLeak = 0;

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
let p4SignFlips = 0;
let p4LastSign = 0;
let p4CycleAccum = 0;
let p4LastLogMs = performance.now();

const P1_DEBUG = true;
const P1_LOG_MS = 2000;

let p1Frames = 0;
let p1Flips = 0;
let p1LastLogMs = performance.now();
let p1PrevSquare = null;
let p1CycleAccum = 0;
let p1PrevFrameTime = null;
let p1JitterCount = 0;

const P1_JITTER_THRESH = 0.003; // seconds (3 ms)
const DISPLAY_GAMMA = 2.2;
const DEFAULT_PARAMS = {
  1: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 }, // max contrast
  2: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 },
  3: { meanAlpha: 0.3, modDepth: 0.3, freq: 40, checkerSize: 12 }, // overlay safe
  4: { meanAlpha: 0.5, modDepth: 0.4, freq: 40, checkerSize: 12 },
  5: { meanAlpha: 0.3, modDepth: 0.3, freq: 40, checkerSize: 12 },
  6: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 },
  7: { meanAlpha: 0.5, modDepth: 0.3, freq: 40, checkerSize: 12 },
};

// ---- Init ----
init();

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
// Param Safety Warnings
// ===============================
function warnIfUnsafe() {
  // Pattern 2 alpha range = meanAlpha ± MOD_DEPTH
  const p2Min = meanAlpha - MOD_DEPTH;
  const p2Max = meanAlpha + MOD_DEPTH;
  const p2Bad = (p2Min < 0) || (p2Max > 1);

  // Pattern 3/4 luminance range = 0.5 ± MOD_DEPTH
  const p34Min = 0.5 - MOD_DEPTH;
  const p34Max = 0.5 + MOD_DEPTH;
  const p34Bad = (p34Min < 0) || (p34Max > 1);

  const MARGIN = 0.02;
  const p2Near = (p2Min < MARGIN) || (p2Max > 1 - MARGIN);
  const p34Near = (p34Min < MARGIN) || (p34Max > 1 - MARGIN);

  const lines = [];
  const pat = currentPattern;

  if (pat === 3 || pat === 0) {
    if (p2Bad) {
      lines.push(
        `[WARN] P3 will CLIP: alpha range [${p2Min.toFixed(3)}, ${p2Max.toFixed(3)}] ` +
        `→ keep MOD_DEPTH <= min(meanAlpha, 1-meanAlpha).`
      );
    } else if (p2Near) {
      lines.push(`[WARN] P3 near clipping: alpha range [${p2Min.toFixed(3)}, ${p2Max.toFixed(3)}]`);
    }
  }

  if (pat === 2 || pat === 4 || pat === 0){
      if (p34Bad) {
      lines.push(
        `[WARN] P${pat === 3 ? "2" : "4"} will CLIP: L range [${p34Min.toFixed(3)}, ${p34Max.toFixed(3)}] ` +
        `→ keep MOD_DEPTH <= 0.5.`
      );
    } else if (p34Near) {
      lines.push(`[WARN] P2/P4 near clipping: L range [${p34Min.toFixed(3)}, ${p34Max.toFixed(3)}]`);
    }
  }

  if (lines.length) {
    for (const l of lines) console.warn(l);
  } else {
    console.log(`[OK] Params safe | meanAlpha=${meanAlpha.toFixed(3)} MOD_DEPTH=${MOD_DEPTH.toFixed(3)} F=${FLICKER_HZ.toFixed(2)}`);
  }
}

// ===============================
// DOM / Canvas / Overlay
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

    // default = normal rendering
    background: "transparent",
    mixBlendMode: "normal",
  });

  document.documentElement.appendChild(canvas);

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

    // Noise/image buffers depend on size
    noiseImageData = null;
    generateNoisePattern();
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
    zIndex: "2147483646",
    opacity: "0",
  });

  document.documentElement.appendChild(overlay);
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

  return sum / steps; // range [-1, 1]
}

// Frame-averaged sine over [t0,t1]
function integratedSineM(t0, t1, f) {
  const dt = t1 - t0;
  if (dt <= 0 || f <= 0) return 0;

  const w = 2 * Math.PI * f;
  const denom = w * dt;

  if (denom < 1e-6) return Math.sin(w * t1);
  return (Math.cos(w * t0) - Math.cos(w * t1)) / denom;
}

// ===============================
// Pattern 4 Noise generation
// ===============================
function generateNoisePattern() {
  if (!canvas) return;

  // CHECKER_SIZE is in backing-store pixels here (keeps phase exact on the rendered buffer)
  const w = Math.ceil(canvas.width / CHECKER_SIZE);
  const h = Math.ceil(canvas.height / CHECKER_SIZE);

  const total = w * h;
  const arr = new Int8Array(total);

  // Fill half +1, half -1
  const half = Math.floor(total / 2);
  for (let i = 0; i < total; i++) arr[i] = i < half ? 1 : -1;

  // Fisher-Yates shuffle
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

// ===============================
// Drawers
// ===============================
function clamp255(x) {
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

function drawChromaticRG(M) {
  if (!ctx || !canvas) return;

  const m = Math.max(-1, Math.min(1, M));

  const base = 128;
  const A = MOD_DEPTH * 128;
  const k = 0.2126 / 0.7152;

  const R = clamp255(base + A * m);
  const G = clamp255(base - k * A * m);
  const B = base;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Transparent chromatic layer
  // ctx.fillStyle = `rgba(${R|0}, ${G|0}, ${B|0}, 0.15)`;
  ctx.fillStyle = `rgb(${R|0}, ${G|0}, ${B|0})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // ---- Luminance tracking ----
  const Y =
    0.2126 * R +
    0.7152 * G +
    0.0722 * B;

  const leak = Y - 128;

  if (leak > p7MaxLeak) p7MaxLeak = leak;
  if (leak < p7MinLeak) p7MinLeak = leak;

  debugPattern7(m, R, G, Y);
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

function drawNoisePattern(M) {
  if (!ctx || !canvas) return;

  if (!noisePattern) {
    generateNoisePattern();
    if (!noisePattern) return;
  }

  const m = Math.max(-1, Math.min(1, M));
  const base = 0.5;
  const depth = MOD_DEPTH;
  const width = canvas.width;
  const height = canvas.height;
  const size = CHECKER_SIZE;

  if (!noiseImageData || noiseImageData.width !== width || noiseImageData.height !== height) {
    noiseImageData = ctx.createImageData(width, height);
  }

  const data = noiseImageData.data;
  let idx = 0;

  for (let by = 0; by < noiseH; by++) {
    for (let bx = 0; bx < noiseW; bx++) {
      const sign = noisePattern[idx++];

      let L = base + sign * depth * m;
      L = clamp01(L);

      const encoded = gammaEncodeLinear01(L);
      const v = (encoded * 255) | 0;

      const startX = bx * size;
      const startY = by * size;

      for (let y = startY; y < startY + size && y < height; y++) {
        const row = y * width;
        for (let x = startX; x < startX + size && x < width; x++) {
          const i = (row + x) * 4;
          data[i] = v;
          data[i + 1] = v;
          data[i + 2] = v;
          data[i + 3] = 255;
        }
      }
    }
  }

  ctx.putImageData(noiseImageData, 0, 0);
}

// ===============================
// Patterns
// ===============================
function pattern1(dt) {
  // Square-wave toggling using accurate accumulator
  acc += dt;
  p1CycleAccum += dt * FLICKER_HZ;

  const halfPeriod = 1 / (2 * FLICKER_HZ);

  while (acc >= halfPeriod) {
    acc -= halfPeriod;
    squareOn = !squareOn;
  }

  return { kind: "fullBW", isWhite: squareOn };
}

// Test Andersen interpolated square works
function pattern2(t0, t1) {
  return {
    kind: "brightness",
    M: integratedSquareM(t0, t1, FLICKER_HZ)
  };
}
//Test overlay works
function pattern3(t0, t1) {
  return {
    kind: "overlayAlpha",
    M: integratedSquareM(t0, t1, FLICKER_HZ)
  };
}
function pattern4(t0, t1) {
  return {
    kind: "brightness",
    M: integratedSineM(t0, t1, FLICKER_HZ)
  };
}
function pattern5(t0, t1) {
  return {
    kind: "overlayAlpha",
    M: integratedSineM(t0, t1, FLICKER_HZ)
  };
}
function pattern6(dt) {
  const fps = dt > 0 ? 1 / dt : 60;

  // how many cycles this frame
  //Compute how much phase to move
  const phaseInc = FLICKER_HZ / fps;

  const prevPhase = p6Phase;
  p6Phase += phaseInc;

  // count how many HALF cycles crossed
  const prevHalf = Math.floor(prevPhase * 2);
  const currHalf = Math.floor(p6Phase * 2);

  const flips = currHalf - prevHalf;

  if (flips !== 0) {
    // flip sign for each crossing
    if (flips % 2 !== 0) {
      p6FlipState *= -1;
    }
  }

  return { kind: "noise", M: p6FlipState, fps, phaseInc, flips };
}
function pattern7(t0, t1) {
  return { kind: "chromatic", M: integratedSineM(t0, t1, FLICKER_HZ) };
}
function debugPattern7(m, R, G, Y) {
  if (!P7_DEBUG) return;

  p7Frames++;

  const now = performance.now();

  if (now - p7LastLogMs >= P7_LOG_MS) {
    const elapsedSec = (now - p7LastLogMs) / 1000;
    const fps = p7Frames / elapsedSec;

    console.log(
      `[P7] fps=${fps.toFixed(1)} ` +
      `| M=${m.toFixed(3)} ` +
      `| R=${R.toFixed(1)} G=${G.toFixed(1)} ` +
      `| Y≈${Y.toFixed(2)} ` +
      `| leakRange=[${p7MinLeak.toFixed(2)}, ${p7MaxLeak.toFixed(2)}] ` +
      `| targetHz=${FLICKER_HZ.toFixed(2)}`
    );

    p7Frames = 0;
    p7LastLogMs = now;
    p7MaxLeak = 0;
    p7MinLeak = 0;
  }
}
function debugPattern6(M, dt, fps, phaseInc, flips) {
  if (!P6_DEBUG) return;

  p6Frames++;

  p6SignFlips += Math.abs(flips);

  const now = performance.now();

  if (now - p6LastLogMs >= P6_LOG_MS) {
    const elapsedSec = (now - p6LastLogMs) / 1000;

    const measuredFps = p6Frames / elapsedSec;
    const flipHz = p6SignFlips / elapsedSec;
    const approxHz = flipHz / 2;

    console.log(
      `[P6] fps=${measuredFps.toFixed(1)} ` +
      `| flips/s=${flipHz.toFixed(2)} ` +
      `| approxHz=${approxHz.toFixed(2)} ` +
      `| target=${FLICKER_HZ.toFixed(2)} ` +
      `| phaseInc=${phaseInc.toFixed(4)} ` +
      `| flips/frame=${flips} ` +
      `| M=${M}`
    );

    p6Frames = 0;
    p6SignFlips = 0;
    p6LastLogMs = now;
  }
}

// ===============================
// Debug logging
// ===============================
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
    const measuredFlipHz = p1Flips / elapsedSec; // half-period flips per second
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
  p4CycleAccum += dt * FLICKER_HZ;

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

// ===============================
// Main Loop
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
  case 1:
    cmd = pattern1(dt);
    break;
  case 2:
    cmd = pattern2(t0, t1);
    break;
  case 3:
    cmd = pattern3(t0, t1);
    break;
  case 4:
    cmd = pattern4(t0, t1);
    break;
  case 5:
    cmd = pattern5(t0, t1);
    break;
  case 6:
    cmd = pattern6(dt);
    break;
  case 7:
    cmd = pattern7(t0, t1);
    break;
  default:
    cmd = pattern1(dt);
    break;
}

  // Execute draw command
  if (cmd.kind === "fullBW") {
    drawFullScreenBW(cmd.isWhite);
    debugPattern1(dt);
  } else if (cmd.kind === "overlayAlpha") {
    drawOverlayAlpha(cmd.M);
  } else if (cmd.kind === "brightness") {
    drawFullScreenLuminance(cmd.M);
    if (currentPattern === 4) {
      debugPattern4(cmd.M, dt);
  }
  } else if (cmd.kind === "noise") {
    drawNoisePattern(cmd.M);
  //   if (currentPattern === 4) {
  //     debugPattern4(cmd.M, dt);
  //   if (metLogger) {
  //     const fpsEstimate = dt > 0 ? 1 / dt : 60;
  //     metLogger({
  //       patternId: currentPattern,
  //       fpsEstimate,
  //       modDepth: MOD_DEPTH,
  //       M: cmd.M
  //     });
  //   }
  // }
  if (currentPattern === 6) {
    debugPattern6(cmd.M, dt, cmd.fps, cmd.phaseInc, cmd.flips);
  }
  }
  else if (cmd.kind === "chromatic") {
      drawChromaticRG(cmd.M);
    }

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
  p1CycleAccum = 0;
  p1PrevFrameTime = null;
  p1JitterCount = 0;
  p1LastLogMs = performance.now();

  // P4 debug
  p4Frames = 0;
  p4SignFlips = 0;
  p4LastSign = 0;
  p4CycleAccum = 0;
  p4LastLogMs = performance.now();

    // P6 debug
  p6Phase = 0;
  p6Frames = 0;
  p6SignFlips = 0;
  p6LastSign = 0;
  p6LastLogMs = performance.now();
  // P7 debug
  p7Frames = 0;
  p7LastLogMs = performance.now();
  p7MaxLeak = 0;
  p7MinLeak = 0;
}

function start(pattern = currentPattern) {
  stop();

  currentPattern = Number(pattern) || 1;
  warnIfUnsafe();

  // Pattern 2 uses overlay (keep canvas cleared if exists)
  if (currentPattern === 3) {
    ensureOverlay();
    if (overlay) overlay.style.opacity = "0";
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);

  } else {
    ensureCanvas();
    if (overlay) overlay.style.opacity = "0";

    //Apply blend mode ONLY for Pattern 7
    if (currentPattern === 7) {
      // canvas.style.mixBlendMode = "color";
      canvas.style.mixBlendMode = "normal";
    } else {
      canvas.style.mixBlendMode = "normal";
    }

    generateNoisePattern(); // harmless for non-P4
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

  if (ctx && canvas) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  if (overlay) {
    overlay.style.opacity = "0";
  }
  if (canvas) {
    canvas.style.mixBlendMode = "normal";
  }

  // in case older experiments used CSS filter
  document.documentElement.style.filter = "";
}

// ===============================
// Messaging
// ===============================
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

    // LOAD that pattern's params
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

  // Update noise if needed
  if (canvas) {
    noiseImageData = null;
    generateNoisePattern();
  }

  warnIfUnsafe();

  // SAVE PER PATTERN
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
}
});