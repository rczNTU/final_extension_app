walking along a 40 Hz wave, but in big jumps.

Frame 1: 0.00 → 0.67
Frame 2: 0.67 → 1.33
Frame 3: 1.33 → 2.00
Frame 4: 2.00 → 2.67


why ISF works
ISF works by:
Changing chromatic channels
Keeping brightness channel almost constant
we have three cone types:

L cones (long wavelength)

M cones (medium wavelength)

S cones (short wavelength)

Perception is built from opponent channels:
Brightness  →  L + M
Red-Green   →  L − M
Blue-Yellow →  S − (L+M)

ISF:The L+M signal (brightness) stays stable
But L−M or S channel oscillates


WHY Gamma correciton needed
function gammaEncodeLinear01(L) {
  return Math.pow(clamp01(L), 1 / DISPLAY_GAMMA);
}
| Pixel value | Actual brightness |
| ----------- | ----------------- |
| 128         | ~0.22 (not 0.5!)  |
