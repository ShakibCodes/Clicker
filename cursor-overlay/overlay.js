/* eslint-disable @typescript-eslint/no-require-imports */
const { desktopCapturer, ipcRenderer } = require("electron");

const cursor = document.getElementById("secondary-cursor");
const statusPanel = document.getElementById("assistant-status");

let targetX = window.innerWidth / 2;
let targetY = window.innerHeight / 2;
let currentX = targetX;
let currentY = targetY;
let latestScreenFrame = null;
let isListening = false;

const sideOffsetX = 42;
const sideOffsetY = 28;
const captureIntervalMs = 2500;
const recordingMs = 4500;

ipcRenderer.on("cursor:position", (_event, payload) => {
  targetX = payload.x;
  targetY = payload.y;
});

function setStatus(text) {
  statusPanel.innerHTML = `<strong>AI Buddy</strong><br />${text}`;
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
      return;
    }

    setStatus(`Heard: "${result.transcript}"<br />${result.message}`);
  } catch (error) {
    setStatus(`Voice error: ${error.message}`);
  } finally {
    isListening = false;
  }
}

ipcRenderer.on("assistant:toggle-listening", () => {
  void listenOnce();
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
