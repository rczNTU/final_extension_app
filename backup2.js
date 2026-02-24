let FLICKER_HZ   = 40;
let MEAN_ALPHA  = 0.10;
let MOD_DEPTH   = 5;
let CHECKER_SIZE = 8;

let p5Colors = null;
let p5Phase = 0;
let p5LastFlip = 0;

let lastNowSec = 0;

//debug
const DEBUG = true;
const LOG_EVERY_N = 60;     // log once per ~1 sec at 60Hz
const JITTER_THRESHOLD = 2; // ms deviation from ideal frame
let frameCount = 0;
let prevFrameMs = null;
let rafJitterEvents = 0;

// Pattern5 debug
let p5ZeroCrossings = 0;
let p5LastSign = 0;
let p5WindowStart = performance.now();
let p5FrameCounter = 0;



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

      img = null; // force redraw-safe

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

function getEffectiveBackgroundColor(x, y) {
  let el = document.elementFromPoint(x, y);
  while (el && el !== document.documentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
      return bg;
    }
    el = el.parentElement;
  }
  return getComputedStyle(document.documentElement).backgroundColor;
}

// =====================================================
// Color Utils
// =====================================================
function parseRGB(rgb) {
  const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function clamp(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function rgbToString({ r, g, b }) {
  return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function suggestOverlayColors(bgRgbStr) {
  const rgb = parseRGB(bgRgbStr);
  if (!rgb) return null;

  const L = luminance(rgb);
  const DELTA = 200;

  let base;
  if (L < 0.25) {
    base = { r: rgb.r + 8, g: rgb.g + 8, b: rgb.b + 8 };
  } else if (L > 0.75) {
    base = { r: rgb.r - 8, g: rgb.g - 8, b: rgb.b - 8 };
  } else {
    base = { ...rgb };
  }

  return {
    luminance: L.toFixed(3),
    base: rgbToString(base),
    modA: rgbToString({ r: base.r + DELTA, g: base.g, b: base.b }),
    modB: rgbToString({ r: base.r - DELTA, g: base.g, b: base.b }),
  };
}

// =====================================================
// Runtime State
// =====================================================
let running = false;
let rafId = null;
let lastTime = 0;

let phase = 0;
let acc = 0;
let squareOn = false;

let currentPattern = 1;
let meanAlpha = MEAN_ALPHA;

// canvas
let canvas = null;
let ctx = null;
let dpr = 1;
let img = null;
let imgW = 0;
let imgH = 0;

// =====================================================
// Canvas
// =====================================================
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

// =====================================================
// Drawing helpers
// =====================================================
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

function drawCheckerboard(M) {
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

  let k = 0;
  for (let y = 0; y < h; y++) {
    const iy = (y / scalePx) | 0;
    for (let x = 0; x < w; x++) {
      const ix = (x / scalePx) | 0;
      const even = ((ix + iy) & 1) === 0;
      const sgn = even ? +1 : -1;
      const a = clamp01(meanAlpha + MOD_DEPTH * sgn * m);
      const v = even ? 255 : 0;
      data[k++] = v;
      data[k++] = v;
      data[k++] = v;
      data[k++] = Math.round(a * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
}

// =====================================================
// Patterns
// =====================================================
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

let p2ZeroCrossings = 0;
let p2LastSign = 0;
let p2WindowStart = performance.now();

function pattern2Update(dt) {
  phase += 2 * Math.PI * FLICKER_HZ * dt;
  const M = Math.sin(phase);

  if (DEBUG) {
    const s = Math.sign(M);
    if (s !== 0 && s !== p2LastSign) {
      p2ZeroCrossings++;
      p2LastSign = s;
    }

    const now = performance.now();
    if (now - p2WindowStart > 2000) {
      const seconds = (now - p2WindowStart) / 1000;
      //2 zero crossings = 1 full oscillations
      //when sign changes is half cycle completed
      const estFreq = (p2ZeroCrossings / 2) / seconds;//How often the computed M value changes sign.

      console.log(
        `[Pattern2] estFreq≈${estFreq.toFixed(2)}Hz`
      );

      p2ZeroCrossings = 0;
      p2WindowStart = now;
    }
  }

  return { kind: "checker", M };
}
let p3ZeroCrossings = 0;
let p3LastSign = 0;
let p3WindowStart = performance.now();
function pattern3Update(t0, t1) {
  const f = FLICKER_HZ;
  const dt = t1 - t0;
  if (dt <= 0) return { kind: "checker", M: 0 };

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

  const fraction = onTime / dt;
  const M = fraction * 2 - 1;

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

      console.log(
        `[Pattern3 Integrated] estFreq≈${estFreq.toFixed(2)}Hz`
      );

      p3ZeroCrossings = 0;
      p3WindowStart = now;
    }
  }

  return { kind: "checker", M };
}


function pattern4Update(dt) {
  phase += 2 * Math.PI * FLICKER_HZ * dt;
  const w = 0.5 + 0.5 * Math.sin(phase);
  return {
    kind: "full",
    color: "red",
    alpha: meanAlpha + MOD_DEPTH * (w * 2 - 1),
  };
}
function parseColorString(str) {
  const m = str.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}
function renderPattern5Integrated(t0, t1) {
  if (!p5Colors || !p5Colors.rgbA || !p5Colors.rgbB) return;

  const f = FLICKER_HZ;
  const dt = t1 - t0;
  if (dt <= 0) return;

  const period = 1 / f;
  const half = period / 2;

  let phaseLocal = ((t0 % period) + period) % period;
  let remaining = dt;
  let onTime = 0;

  while (remaining > 0) {
    const inA = phaseLocal < half;
    const nextBoundary = inA ? half : period;
    const segment = Math.min(remaining, nextBoundary - phaseLocal);

    if (inA) onTime += segment;

    remaining -= segment;
    phaseLocal += segment;
    if (phaseLocal >= period) phaseLocal -= period;
  }

  const fractionA = onTime / dt;
  const fractionB = 1 - fractionA;

  const A = p5Colors.rgbA;
  const B = p5Colors.rgbB;

  const r = Math.round(A.r * fractionA + B.r * fractionB);
  const g = Math.round(A.g * fractionA + B.g * fractionB);
  const b = Math.round(A.b * fractionA + B.b * fractionB);

  // Render
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = clamp01(meanAlpha);
  ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalAlpha = 1;

  // -----------------------
  // DEBUG SECTION
  // -----------------------
  if (DEBUG) {
    p5FrameCounter++;

    // Detect sign flips for alias frequency estimation
    const M = fractionA * 2 - 1;  // convert to [-1,1] for analysis
    const s = Math.sign(M);

    if (s !== 0 && s !== p5LastSign) {
      p5ZeroCrossings++;
      p5LastSign = s;
    }

    const now = performance.now();

    // Log frequency every 2 seconds
    if (now - p5WindowStart > 2000) {
      const seconds = (now - p5WindowStart) / 1000;
      const estFreq = (p5ZeroCrossings / 2) / seconds;

      console.log(
        `[Pattern5 Integrated]
        estFreq≈${estFreq.toFixed(2)}Hz
        avgFractionA≈${fractionA.toFixed(3)}
        dt≈${(dt * 1000).toFixed(2)}ms`
      );

      p5ZeroCrossings = 0;
      p5WindowStart = now;
    }

    // Occasionally inspect color blend
    if (p5FrameCounter % LOG_EVERY_N === 0) {
      console.log(
        `[Pattern5 Blend]
        fractionA=${fractionA.toFixed(3)}
        rgb=(${r},${g},${b})`
      );
    }
  }
}



function loop(now) {
  if (!running) return;
  frameCount++;

if (prevFrameMs !== null) {
  const dtMs = now - prevFrameMs;
  const ideal = 1000 / 60; // assuming 60Hz panel
  const deviation = Math.abs(dtMs - ideal);

  if (deviation > JITTER_THRESHOLD) {
    rafJitterEvents++;
  }
  //dt is the time between two requestAnimationFrame calls.
  if (DEBUG && frameCount % LOG_EVERY_N === 0) {
    console.log(
      `[RAF] dt=${dtMs.toFixed(2)}ms | jitterEvents=${rafJitterEvents}`
    );
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

  if (currentPattern === 5) {
    renderPattern5Integrated(t0, t1);
    rafId = requestAnimationFrame(loop);
    return;
  }


  switch (currentPattern) {
    case 1:
      cmd = pattern1Update(dt);
      break;

    case 2:
      cmd = pattern2Update(dt);   // naive sine sampling
      break;

    case 3:
      cmd = pattern3Update(t0, t1); // integrated square
      break;

    case 4:
      cmd = pattern4Update(dt);
      break;
  }

  if (cmd.kind === "full") drawFullScreen(cmd.color, cmd.alpha);
  else drawCheckerboard(cmd.M);

  rafId = requestAnimationFrame(loop);
}


function start(pattern = currentPattern) {
  ensureCanvas();
  resizeCanvas();

  currentPattern = pattern;
  phase = acc = 0;
  squareOn = true;

  if (currentPattern === 5) {
    const bg = getEffectiveBackgroundColor(innerWidth / 2, innerHeight / 2);
    p5Colors = suggestOverlayColors(bg);
    p5Colors.rgbA = parseColorString(p5Colors.modA);
    p5Colors.rgbB = parseColorString(p5Colors.modB);

    p5Phase = 0;
    p5LastFlip = performance.now();

    console.groupCollapsed("[P5] Pattern 5 initialized");
    console.log("freq:", FLICKER_HZ, "Hz");
    console.log("meanAlpha:", meanAlpha);
    console.log("background:", bg);
    console.log("adaptive colors:", p5Colors);
    console.groupEnd();
  }

  running = true;
  lastTime = performance.now();
  lastNowSec = 0;
  rafId = requestAnimationFrame(loop);
}

function stop() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}


// ---------- Messaging ----------
chrome.runtime.onMessage.addListener((msg) => {
   console.log("[CONTENT] Message received:", msg);
    if (msg?.type === "START") {
  chrome.storage.local.set(
    {
      autoStart: true,
      currentPattern: msg.pattern || currentPattern
    },
    () => {
      hydrateFromStorageAndMaybeStart(true);
    }
  );
}



  if (msg?.type === "STOP") {
    stop();
    chrome.storage.local.set({ autoStart: false });
  }

  if (msg?.type === "SET_PATTERN") {
    currentPattern = Number(msg.pattern) || 1;

    chrome.storage.local.set({
      currentPattern
    });
  }

  if (msg?.type === "SET_PARAMS") {
    if (typeof msg.meanAlpha === "number") meanAlpha = msg.meanAlpha;
    if (typeof msg.modDepth === "number") MOD_DEPTH = msg.modDepth;
    if (typeof msg.checkerSize === "number") {
      CHECKER_SIZE = msg.checkerSize;
      img = null;
    }
    if (typeof msg.freq === "number") FLICKER_HZ = msg.freq;
    if (currentPattern === 5 && typeof msg.modDepth === "number") {
      const bg = getEffectiveBackgroundColor(
        window.innerWidth / 2,
        window.innerHeight / 2
      );
      p5Colors = suggestOverlayColors(bg);
    }


    chrome.storage.local.set({
      meanAlpha,
      modDepth: MOD_DEPTH,
      checkerSize: CHECKER_SIZE,
      freq: FLICKER_HZ
    });
  }
});

// function sendToFlaskNonBlocking(endpoint, payload) {
//   setTimeout(() => {
//     fetch(endpoint, {
//       method: "POST",
//       headers: { "Content-Type": "application/json" },
//       body: JSON.stringify(payload)
//     }).catch(() => {});
//   }, 0);
// }