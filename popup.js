function send(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  });
}



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
  s.oninput = sendParams;
});

document.getElementById("start").onclick = () => send({ type: "START" });
document.getElementById("stop").onclick = () => send({ type: "STOP" });

document.querySelectorAll("button[data-p]").forEach(btn => {
  btn.onclick = () => {
    const p = Number(btn.dataset.p);
    console.log("[POPUP] Pattern button clicked:", p);

    send({
      type: "START",
      pattern: p
    });
  };
});



// restore slider values
chrome.storage.local.get(
  ["freq", "meanAlpha", "modDepth", "checkerSize"],
  (s) => {
    freq.value = s.freq ?? 40;
    meanAlpha.value = s.meanAlpha ?? 0.10;
    modDepth.value = s.modDepth ?? 0.05;
    checkerSize.value = s.checkerSize ?? 8;
    updateLabels();
    sendParams();

  }
);
