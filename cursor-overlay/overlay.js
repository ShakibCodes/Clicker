/* eslint-disable @typescript-eslint/no-require-imports */
const { desktopCapturer, ipcRenderer } = require("electron");

const cursor = document.getElementById("secondary-cursor");
const clickRing = document.getElementById("click-ring");
const statusPanel = document.getElementById("assistant-status");

let targetX = window.innerWidth / 2;
let targetY = window.innerHeight / 2;
let currentX = targetX;
let currentY = targetY;
let latestScreenFrame = null;
let isListening = false;
let currentAssistantAudio = null;
let isGuidedTourRunning = false;
let isGuidedControlActive = false;

const sideOffsetX = 42;
const sideOffsetY = 28;
const captureIntervalMs = 2500;
const recordingMs = 4500;

ipcRenderer.on("cursor:position", (_event, payload) => {
  if (isGuidedControlActive) {
    return;
  }
  targetX = payload.x;
  targetY = payload.y;
});

function setStatus(text) {
  statusPanel.innerHTML = `<strong>AI Buddy</strong><br />${text}`;
}

async function playAssistantAudio(tts) {
  if (!tts || !tts.audioBase64) {
    return;
  }

  try {
    const mimeType = tts.mimeType || "audio/mpeg";
    const binary = atob(tts.audioBase64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    const blob = new Blob([bytes], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.volume = 1;
    currentAssistantAudio = audio;

    await new Promise((resolve, reject) => {
      const onEnded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Failed to play assistant audio."));
      };
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        URL.revokeObjectURL(objectUrl);
        if (currentAssistantAudio === audio) {
          currentAssistantAudio = null;
        }
      };

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.play().catch((error) => {
        cleanup();
        reject(error);
      });
    });
  } catch (error) {
    setStatus(`Audio playback issue: ${error.message}`);
  }
}

async function captureScreenFrame() {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: 640,
      height: 360,
    },
  });

  if (sources.length === 0) {
    return null;
  }

  const firstSource = sources[0];
  return firstSource.thumbnail.toDataURL();
}

async function refreshScreenContext() {
  try {
    latestScreenFrame = await captureScreenFrame();
  } catch {
    latestScreenFrame = null;
  }
}

function stripDataUrlPrefix(dataUrl) {
  const idx = dataUrl.indexOf(",");
  if (idx === -1) {
    return dataUrl;
  }

  return dataUrl.slice(idx + 1);
}

async function recordMicrophoneChunk(durationMs) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false,
  });

  return new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = () => {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      reject(new Error("Microphone recording failed."));
    };

    recorder.onstop = async () => {
      for (const track of stream.getTracks()) {
        track.stop();
      }

      try {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const reader = new FileReader();

        reader.onloadend = () => {
          const result = String(reader.result || "");
          resolve({
            audioBase64: stripDataUrlPrefix(result),
            mimeType: "audio/webm",
          });
        };

        reader.onerror = () => {
          reject(new Error("Failed to encode microphone audio."));
        };

        reader.readAsDataURL(blob);
      } catch {
        reject(new Error("Failed while preparing microphone audio."));
      }
    };

    recorder.start();
    setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    }, durationMs);
  });
}

async function listenOnce() {
  if (isListening) {
    return;
  }

  isListening = true;

  try {
    setStatus("Listening... speak now.");
    const audioPayload = await recordMicrophoneChunk(recordingMs);

    setStatus("Transcribing with Groq Whisper...");
    await refreshScreenContext();
    const cursorContext = await ipcRenderer.invoke("assistant:cursor-context");

    const result = await ipcRenderer.invoke("assistant:listen-and-execute", {
      audioBase64: audioPayload.audioBase64,
      mimeType: audioPayload.mimeType,
      screenFrame: latestScreenFrame,
      cursorContext,
    });

    if (!result.ok) {
      setStatus(result.message);
      await playAssistantAudio(result.tts);
      return;
    }

    setStatus(`Heard: "${result.transcript}"<br />${result.message}`);
    await playAssistantAudio(result.tts);
  } catch (error) {
    setStatus(`Voice error: ${error.message}`);
  } finally {
    isListening = false;
  }
}

ipcRenderer.on("assistant:toggle-listening", () => {
  void listenOnce();
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntilCursorNearTarget(maxWaitMs = 2200) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const dx = Math.abs(targetX - currentX);
    const dy = Math.abs(targetY - currentY);
    if (dx < 14 && dy < 14) {
      return;
    }
    await sleep(16);
  }
}

function showClickCue(x, y) {
  cursor.classList.add("clicking");
  clickRing.classList.remove("active");
  clickRing.style.setProperty("--x", `${x + sideOffsetX - 9}px`);
  clickRing.style.setProperty("--y", `${y + sideOffsetY - 9}px`);
  void clickRing.offsetWidth;
  clickRing.classList.add("active");
  setTimeout(() => {
    cursor.classList.remove("clicking");
  }, 320);
}

async function speakStep(stepText) {
  const tts = await ipcRenderer.invoke("assistant:speak-text", stepText);
  if (tts?.ok && tts.audioBase64) {
    await playAssistantAudio({
      audioBase64: tts.audioBase64,
      mimeType: tts.mimeType || "audio/mpeg",
    });
  } else {
    await sleep(1600);
  }
}

ipcRenderer.on("assistant:guided-tour", async (_event, payload) => {
  if (isGuidedTourRunning) {
    return;
  }

  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  const software = payload?.software || "this software";
  if (steps.length === 0) {
    return;
  }

  isGuidedTourRunning = true;
  isGuidedControlActive = true;

  try {
    setStatus(`Guided tour started for ${software}.`);

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (!step || typeof step.x !== "number" || typeof step.y !== "number") {
        continue;
      }

      targetX = step.x;
      targetY = step.y;
      await waitUntilCursorNearTarget();

      const stepLabel = `Step ${i + 1}/${steps.length}`;
      const needsClick = Boolean(step.click);
      const actionLabel = needsClick ? "Click here" : "Look here";
      setStatus(`${stepLabel} - ${actionLabel}<br />${step.text || "Review this area."}`);
      await sleep(900);
      if (needsClick) {
        showClickCue(step.x, step.y);
      }
      await speakStep(`${stepLabel}. ${actionLabel}. ${step.text || "Review this area."}`);
      await sleep(180);
    }

    setStatus(`Guided tour finished for ${software}. Press Ctrl+Shift+V for another command.`);
  } catch (error) {
    setStatus(`Guided tour issue: ${error.message}`);
  } finally {
    isGuidedTourRunning = false;
    isGuidedControlActive = false;
  }
});

setInterval(() => {
  void refreshScreenContext();
}, captureIntervalMs);

function animate() {
  currentX += (targetX - currentX) * 0.13;
  currentY += (targetY - currentY) * 0.13;

  cursor.style.transform = `translate3d(${currentX + sideOffsetX}px, ${currentY + sideOffsetY}px, 0)`;
  window.requestAnimationFrame(animate);
}

window.requestAnimationFrame(animate);
