function send(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  });
}


let isLoading = false;
const freq = document.getElementById("freq");
const meanAlpha = document.getElementById("meanAlpha");
const modDepth = document.getElementById("modDepth");
const checkerSize = document.getElementById("checkerSize");

const freqVal = document.getElementById("freqVal");
const meanAlphaVal = document.getElementById("meanAlphaVal");
const modDepthVal = document.getElementById("modDepthVal");
const checkerSizeVal = document.getElementById("checkerSizeVal");

function updateLabels() {
  freqVal.textContent = freq.value;
  meanAlphaVal.textContent = meanAlpha.value;
  modDepthVal.textContent = modDepth.value;
  checkerSizeVal.textContent = checkerSize.value;
}

function sendParams() {
  send({
    type: "SET_PARAMS",
    freq: Number(freq.value),
    meanAlpha: Number(meanAlpha.value),
    modDepth: Number(modDepth.value),
    checkerSize: Number(checkerSize.value)
  });
  updateLabels();
}

[freq, meanAlpha, modDepth, checkerSize].forEach(s => {
  s.oninput = () => {
    if (isLoading) return; 
    sendParams();
  };
});

document.getElementById("start").onclick = () => send({ type: "START" });
document.getElementById("stop").onclick = () => send({ type: "STOP" });

document.querySelectorAll("button[data-p]").forEach(btn => {
  btn.onclick = () => {
    const p = Number(btn.dataset.p);
    console.log("[POPUP] Pattern button clicked:", p);

    send({
      type: "SET_PATTERN",
      pattern: p
    });

    send({
      type: "START",
      pattern: p
    });
  };
});

function loadUIFromStorage() {
  chrome.storage.local.get(["patternParams", "currentPattern"], (s) => {
    isLoading = true;

    const pat = s.currentPattern ?? 1;
    const all = s.patternParams || {};

    const DEFAULT_PARAMS = {
      1: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 },
      2: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 },
      3: { meanAlpha: 0.3, modDepth: 0.3, freq: 40, checkerSize: 12 },
      4: { meanAlpha: 0.5, modDepth: 0.4, freq: 40, checkerSize: 12 },
      5: { meanAlpha: 0.3, modDepth: 0.3, freq: 40, checkerSize: 12 },
      6: { meanAlpha: 0.5, modDepth: 0.5, freq: 40, checkerSize: 12 },
      7: { meanAlpha: 0.5, modDepth: 0.3, freq: 40, checkerSize: 12 },
    };

    const p = all[pat] || DEFAULT_PARAMS[pat];

    freq.value = p.freq;
    meanAlpha.value = p.meanAlpha;
    modDepth.value = p.modDepth;
    checkerSize.value = p.checkerSize;

    updateLabels();

    isLoading = false;

    console.log("[POPUP LOAD]", pat, p);
  });
}
document.addEventListener("DOMContentLoaded", () => {
  loadUIFromStorage();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.patternParams || changes.currentPattern) {
    loadUIFromStorage();
  }
});
