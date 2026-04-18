function loop(nowMs) {
  const nowSec = nowMs / 1000;

  if (lastNowSec === 0) {
    lastNowSec = nowSec;
    return requestAnimationFrame(loop);
  }

  const t0 = lastNowSec;
  const t1 = nowSec;
  const dt = t1 - t0;
  lastNowSec = nowSec;

  const cmd = generateStimulus(currentPattern, t0, t1, dt);
  render(cmd);

  requestAnimationFrame(loop);

}
function generateStimulus(p, t0, t1, dt) {
  switch (p) {
    case 1:
      acc += dt;
      if (acc >= 1/(2*FLICKER_HZ)) {
        acc -= 1/(2*FLICKER_HZ);
        squareOn = !squareOn;
      }
      return { kind: "fullBW", isWhite: squareOn };

    case 4:
      return { kind: "brightness", M: integratedSineM(t0, t1, FLICKER_HZ) };
  }
}
