// metrics_contrast.js
// Only two metrics: Instant Michelson contrast + RMS contrast over time window.

(() => {
  const DEFAULT_LOG_MS = 2000;

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }

  // Michelson contrast between two luminances:
  // C = (Lhi - Llo) / (Lhi + Llo)
  function michelson(Lhi, Llo) {
    const denom = Lhi + Llo;
    if (denom <= 1e-12) return 0;
    return (Lhi - Llo) / denom;
  }

  // For your Pattern 4/6 noise checker:
  // L+ = 0.5 + depth * |M|
  // L- = 0.5 - depth * |M|
  function contrastNowForNoise({ modDepth, M }) {
    const a = Math.abs(Math.max(-1, Math.min(1, M)));
    const Lhi = clamp01(0.5 + modDepth * a);
    const Llo = clamp01(0.5 - modDepth * a);
    const C = michelson(Lhi, Llo);
    return { C, a, Lhi, Llo };
  }

  // Creates a windowed RMS logger
  function createContrastRmsLogger({ logMs = DEFAULT_LOG_MS } = {}) {
    let frames = 0;
    let c2Sum = 0;
    let lastLogMs = performance.now();

    return function update({ patternId, fpsEstimate, modDepth, M }) {
      const { C, a } = contrastNowForNoise({ modDepth, M });

      frames++;
      c2Sum += C * C;

      const now = performance.now();
      if (now - lastLogMs >= logMs) {
        const elapsedSec = (now - lastLogMs) / 1000;
        const fps = fpsEstimate ?? (frames / elapsedSec);

        const C_rms = Math.sqrt(c2Sum / Math.max(1, frames));

        console.log(
          `[MET] pat=${patternId} fps=${fps.toFixed(1)} ` +
          `| C_now=${C.toFixed(3)} | C_rms=${C_rms.toFixed(3)} ` +
          `| depth=${modDepth.toFixed(3)} | |M|=${a.toFixed(3)}`
        );

        frames = 0;
        c2Sum = 0;
        lastLogMs = now;
      }

      return C; // in case you want to use it elsewhere
    };
  }

  // Expose a small API on window
  window.ContrastMetrics = {
    michelson,
    contrastNowForNoise,
    createContrastRmsLogger,
  };
})();