/* eslint-disable @typescript-eslint/no-require-imports */
const { desktopCapturer, ipcRenderer } = require("electron");

const cursor = document.getElementById("secondary-cursor");
const assistantNotch = document.getElementById("assistant-notch");
const voiceBars = Array.from(document.querySelectorAll(".voice-bar"));
const clickRing = document.getElementById("click-ring");
const tooltip = document.getElementById("cursor-tooltip");
const statusPanel = document.getElementById("assistant-status");
const cursorWidth = 13;
const cursorHeight = 15;

let targetX = window.innerWidth / 2;
let targetY = window.innerHeight / 2;
let currentX = targetX;
let currentY = targetY;
let latestScreenFrame = null;
let isListening = false;
let isExecuting = false;
let currentAssistantAudio = null;
let currentAssistantObjectUrl = "";
let currentAssistantResolve = null;
let currentAssistantCleanup = null;
let queuedInterruptionListen = false;
let isGuidedTourRunning = false;
let isGuidedControlActive = false;
let tooltipText = "";

const followOffsetX = 42;
const followOffsetY = 28;
const guidedOffsetX = -(cursorWidth / 2);
const guidedOffsetY = -(cursorHeight / 2);
let activeOffsetX = followOffsetX;
let activeOffsetY = followOffsetY;
const captureIntervalMs = 2500;
const recordingTimeoutMs = 12000;
const initialSpeechTimeoutMs = 5000;
const minRecordingMs = 900;
const silenceToStopMs = 950;
const speechRmsThreshold = 0.035;
const interruptionRmsThreshold = 0.045;
const interruptionHoldMs = 260;
let visualizerRafId = null;
const allowedCursorColors = new Set(["blue", "green", "yellow", "red"]);

function updateAssistantNotch(nextX, nextY) {
  if (!assistantNotch) {
    return;
  }

  const notchCenterX = window.innerWidth / 2;
  const horizontalDistance = Math.abs(nextX - notchCenterX);
  const isNearCollapsedNotch = nextY <= 42 && horizontalDistance <= 92;
  const isNearExpandedNotch = nextY <= 212 && horizontalDistance <= 228;
  const shouldExpand = assistantNotch.classList.contains("expanded") ? isNearExpandedNotch : isNearCollapsedNotch;
  assistantNotch.classList.toggle("expanded", shouldExpand);
}

function renderCursor() {
  const drawX = currentX + activeOffsetX;
  const drawY = currentY + activeOffsetY;
  cursor.style.transform = `translate3d(${drawX}px, ${drawY}px, 0)`;
  renderTooltip(drawX, drawY);
}

function renderTooltip(cursorX, cursorY) {
  if (!tooltip || !tooltipText) {
    return;
  }

  const tooltipWidth = tooltip.offsetWidth || 0;
  const tooltipHeight = tooltip.offsetHeight || 0;
  // Anchor to right-bottom of secondary cursor.
  const left = Math.round(cursorX + cursorWidth + 6);
  const top = Math.round(cursorY + cursorHeight + 6);
  const safeLeft = Math.max(6, Math.min(window.innerWidth - tooltipWidth - 6, left));
  const safeTop = Math.max(6, Math.min(window.innerHeight - tooltipHeight - 6, top));
  tooltip.style.left = `${safeLeft}px`;
  tooltip.style.top = `${safeTop}px`;
}

function showTooltip(text) {
  if (!tooltip) {
    return;
  }
  tooltipText = String(text || "").trim();
  if (!tooltipText) {
    hideTooltip();
    return;
  }
  tooltip.textContent = tooltipText;
  tooltip.classList.add("visible");
  renderTooltip(currentX + activeOffsetX, currentY + activeOffsetY);
}

function hideTooltip() {
  if (!tooltip) {
    return;
  }
  tooltipText = "";
  tooltip.textContent = "";
  tooltip.classList.remove("visible");
}

function buildStepTooltip(step, index, totalSteps) {
  const focusPrompts = ["Look here", "Here!", "See this", "This part"];
  const clickPrompts = ["Click here", "This one!", "Tap here", "Click this"];
  const prompts = step?.click ? clickPrompts : focusPrompts;
  const prompt = prompts[index % prompts.length];

  if (totalSteps <= 1) {
    return step?.click ? "This one!" : "Found it";
  }
  return prompt;
}

ipcRenderer.on("cursor:position", (_event, payload) => {
  if (isGuidedControlActive) {
    return;
  }
  targetX = payload.x;
  targetY = payload.y;
  updateAssistantNotch(targetX, targetY);
});

function setStatus(text) {
  if (!statusPanel) {
    return;
  }
  statusPanel.textContent = String(text || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setVoiceVisualizerLevel(level) {
  if (voiceBars.length === 0) {
    return;
  }

  const clamped = Math.max(0, Math.min(1, level));
  for (let i = 0; i < voiceBars.length; i += 1) {
    const position = i / Math.max(voiceBars.length - 1, 1);
    const shapeBoost = 0.12 + (0.28 * (1 - Math.abs(position - 0.5) * 2));
    const barLevel = Math.max(0, Math.min(1, clamped + shapeBoost - 0.16));
    voiceBars[i].style.setProperty("--level", barLevel.toFixed(3));
  }
}

function setExecutingState(nextState) {
  isExecuting = Boolean(nextState);
  if (!cursor) {
    return;
  }
  if (isExecuting) {
    cursor.classList.remove("listening");
    cursor.classList.add("executing");
    setVoiceVisualizerLevel(0);
    return;
  }
  cursor.classList.remove("executing");
}

function startVoiceVisualizer(stream) {
  if (!cursor) {
    return () => {};
  }

  cursor.classList.add("listening");
  cursor.classList.remove("executing");
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    setVoiceVisualizerLevel(0.2);
    return () => {
      cursor.classList.remove("listening");
      setVoiceVisualizerLevel(0);
    };
  }

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.76;
  source.connect(analyser);

  const pcmData = new Float32Array(analyser.fftSize);
  let smoothedLevel = 0;

  const animateLevel = () => {
    analyser.getFloatTimeDomainData(pcmData);
    let sumSquares = 0;
    for (let i = 0; i < pcmData.length; i += 1) {
      const sample = pcmData[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / pcmData.length);
    const normalized = Math.max(0, Math.min(1, (rms - 0.015) * 6.5));
    smoothedLevel += (normalized - smoothedLevel) * 0.28;
    setVoiceVisualizerLevel(smoothedLevel);
    visualizerRafId = window.requestAnimationFrame(animateLevel);
  };

  animateLevel();

  return () => {
    if (visualizerRafId !== null) {
      window.cancelAnimationFrame(visualizerRafId);
      visualizerRafId = null;
    }
    setVoiceVisualizerLevel(0);
    cursor.classList.remove("listening");
    source.disconnect();
    analyser.disconnect();
    audioContext.close().catch(() => {});
  };
}

async function playAssistantAudio(tts) {
  if (!tts || !tts.audioBase64) {
    return { interrupted: false };
  }

  try {
    stopAssistantAudio({ interrupted: false });
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
    currentAssistantObjectUrl = objectUrl;

    return await new Promise((resolve, reject) => {
      let wasInterrupted = false;
      currentAssistantResolve = resolve;
      const stopBargeInMonitor = startBargeInMonitor(() => {
        if (audio.paused || audio.ended) {
          return;
        }
        wasInterrupted = true;
        audio.pause();
        audio.currentTime = 0;
        cleanup();
        resolve({ interrupted: true });
      });

      const onEnded = () => {
        cleanup();
        resolve({ interrupted: false });
      };
      const onError = () => {
        cleanup();
        reject(new Error("Failed to play assistant audio."));
      };
      const cleanup = () => {
        stopBargeInMonitor();
        if (!audio.paused && !audio.ended) {
          audio.pause();
          audio.currentTime = 0;
        }
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        URL.revokeObjectURL(objectUrl);
        if (currentAssistantAudio === audio) {
          currentAssistantAudio = null;
          currentAssistantObjectUrl = "";
          currentAssistantResolve = null;
          currentAssistantCleanup = null;
        }
      };
      currentAssistantCleanup = cleanup;

      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      audio.play().catch((error) => {
        cleanup();
        if (wasInterrupted) {
          resolve({ interrupted: true });
          return;
        }
        reject(error);
      });
    });
  } catch (error) {
    setStatus(`Audio playback issue: ${error.message}`);
    return { interrupted: false };
  }
}

function stopAssistantAudio(result = { interrupted: false }) {
  const resolveCurrent = currentAssistantResolve;
  const cleanupCurrent = currentAssistantCleanup;

  if (cleanupCurrent) {
    cleanupCurrent();
  }

  if (currentAssistantAudio) {
    currentAssistantAudio.pause();
    currentAssistantAudio.currentTime = 0;
    currentAssistantAudio = null;
  }

  if (currentAssistantObjectUrl) {
    URL.revokeObjectURL(currentAssistantObjectUrl);
    currentAssistantObjectUrl = "";
  }

  currentAssistantResolve = null;
  currentAssistantCleanup = null;
  if (resolveCurrent) {
    resolveCurrent(result);
  }
}

function startBargeInMonitor(onInterrupt) {
  if (isGuidedTourRunning) {
    return () => {};
  }

  let stopped = false;
  let stream = null;
  let audioContext = null;
  let source = null;
  let analyser = null;
  let monitorInterval = null;
  let speechStartedAt = 0;

  const stop = () => {
    stopped = true;
    if (monitorInterval !== null) {
      clearInterval(monitorInterval);
      monitorInterval = null;
    }
    if (source) {
      source.disconnect();
    }
    if (analyser) {
      analyser.disconnect();
    }
    if (audioContext) {
      audioContext.close().catch(() => {});
    }
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
  };

  navigator.mediaDevices
    .getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    .then((nextStream) => {
      if (stopped) {
        for (const track of nextStream.getTracks()) {
          track.stop();
        }
        return;
      }

      stream = nextStream;
      const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextCtor) {
        return;
      }

      audioContext = new AudioContextCtor();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.74;
      source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      const pcmData = new Float32Array(analyser.fftSize);

      monitorInterval = setInterval(() => {
        const rms = getStreamRms(analyser, pcmData);
        const now = Date.now();

        if (rms >= interruptionRmsThreshold) {
          if (!speechStartedAt) {
            speechStartedAt = now;
          }
          if (now - speechStartedAt >= interruptionHoldMs) {
            stop();
            onInterrupt();
          }
          return;
        }

        speechStartedAt = 0;
      }, 60);
    })
    .catch(() => {});

  return stop;
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

function getStreamRms(analyser, pcmData) {
  analyser.getFloatTimeDomainData(pcmData);
  let sumSquares = 0;
  for (let i = 0; i < pcmData.length; i += 1) {
    const sample = pcmData[i];
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / pcmData.length);
}

async function recordMicrophoneUntilSilence() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  const stopVisualizer = startVoiceVisualizer(stream);
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  const audioContext = AudioContextCtor ? new AudioContextCtor() : null;
  const analyser = audioContext ? audioContext.createAnalyser() : null;
  const source = audioContext ? audioContext.createMediaStreamSource(stream) : null;
  const pcmData = analyser ? new Float32Array(analyser.fftSize) : null;

  if (analyser && source) {
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    let monitorInterval = null;
    let forcedStopTimeout = null;
    let hasHeardSpeech = false;
    let firstSpeechAt = 0;
    let lastSpeechAt = 0;
    const startedAt = Date.now();

    const cleanup = () => {
      if (monitorInterval !== null) {
        clearInterval(monitorInterval);
        monitorInterval = null;
      }
      if (forcedStopTimeout !== null) {
        clearTimeout(forcedStopTimeout);
        forcedStopTimeout = null;
      }
      stopVisualizer();
      if (source) {
        source.disconnect();
      }
      if (analyser) {
        analyser.disconnect();
      }
      if (audioContext) {
        audioContext.close().catch(() => {});
      }
      for (const track of stream.getTracks()) {
        track.stop();
      }
    };

    const stopRecorder = () => {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
    };

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = () => {
      cleanup();
      reject(new Error("Microphone recording failed."));
    };

    recorder.onstop = async () => {
      cleanup();

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

    forcedStopTimeout = setTimeout(stopRecorder, recordingTimeoutMs);

    monitorInterval = setInterval(() => {
      const now = Date.now();
      const elapsed = now - startedAt;
      const rms = analyser && pcmData ? getStreamRms(analyser, pcmData) : 0;
      const isSpeaking = rms >= speechRmsThreshold;

      if (isSpeaking) {
        if (!hasHeardSpeech) {
          firstSpeechAt = now;
          setStatus("Listening... keep going.");
        }
        hasHeardSpeech = true;
        lastSpeechAt = now;
        return;
      }

      if (!hasHeardSpeech && elapsed >= initialSpeechTimeoutMs) {
        stopRecorder();
        return;
      }

      if (hasHeardSpeech && now - firstSpeechAt >= minRecordingMs && now - lastSpeechAt >= silenceToStopMs) {
        stopRecorder();
      }
    }, 80);
  });
}

async function listenOnce() {
  if (isListening) {
    return;
  }

  isListening = true;
  queuedInterruptionListen = false;

  try {
    setStatus("Listening... speak now.");
    const audioPayload = await recordMicrophoneUntilSilence();

    setStatus("Transcribing with Groq Whisper...");
    await refreshScreenContext();
    const cursorContext = await ipcRenderer.invoke("assistant:cursor-context");

    setExecutingState(true);
    const result = await ipcRenderer.invoke("assistant:listen-and-execute", {
      audioBase64: audioPayload.audioBase64,
      mimeType: audioPayload.mimeType,
      screenFrame: latestScreenFrame,
      cursorContext,
    });

    if (queuedInterruptionListen) {
      return;
    }

    if (!result.ok) {
      setStatus(result.message);
      const playback = await playAssistantAudio(result.tts);
      queuedInterruptionListen = Boolean(playback?.interrupted);
      return;
    }

    setStatus(`Heard: "${result.transcript}"<br />${result.message}`);
    const playback = await playAssistantAudio(result.tts);
    queuedInterruptionListen = Boolean(playback?.interrupted);
  } catch (error) {
    setStatus(`Voice error: ${error.message}`);
  } finally {
    setExecutingState(false);
    isListening = false;
    if (queuedInterruptionListen) {
      queuedInterruptionListen = false;
      setStatus("Listening... go ahead.");
      setTimeout(() => {
        void listenOnce();
      }, 90);
    }
  }
}

ipcRenderer.on("assistant:toggle-listening", () => {
  void listenOnce();
});

ipcRenderer.on("assistant:status", (_event, payload) => {
  setStatus(payload?.text || "Working...");
});

ipcRenderer.on("assistant:play-tts", (_event, payload) => {
  if (payload?.statusText) {
    setStatus(payload.statusText);
  }
  void playAssistantAudio(payload).then((playback) => {
    if (playback?.interrupted) {
      queuedInterruptionListen = true;
      setStatus("Listening... go ahead.");
    }
  });
});

ipcRenderer.on("cursor:set-color", (_event, payload) => {
  const color = String(payload?.color || "blue").toLowerCase();
  if (!cursor || !allowedCursorColors.has(color)) {
    return;
  }
  cursor.dataset.color = color === "blue" ? "" : color;
});

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntilCursorNearTarget(maxWaitMs = 2200, tolerancePx = 2) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const dx = Math.abs(targetX - currentX);
    const dy = Math.abs(targetY - currentY);
    if (dx <= tolerancePx && dy <= tolerancePx) {
      return;
    }
    await sleep(16);
  }
}

async function moveCursorTo(x, y, maxWaitMs = 2200) {
  targetX = x;
  targetY = y;
  await waitUntilCursorNearTarget(maxWaitMs, 2);

  // Force an exact landing so guided pointing is pixel-precise.
  currentX = x;
  currentY = y;
  renderCursor();
}

function showClickCue(x, y) {
  cursor.classList.add("clicking");
  clickRing.classList.remove("active");
  clickRing.style.setProperty("--x", `${x - 9}px`);
  clickRing.style.setProperty("--y", `${y - 9}px`);
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

function buildNaturalStepSpeech(step, index, totalSteps) {
  const note = step?.text || "Review this area.";
  const intros = [
    "Take a look here.",
    "Now look at this.",
    "Next, focus here.",
    "Great, now this area.",
  ];
  const intro = intros[index % intros.length];
  const clickHint = step?.click ? "This is the one to click." : "Just note this spot.";
  if (totalSteps <= 1) {
    return `${intro} ${note} ${clickHint}`;
  }
  return `${intro} ${note} ${clickHint}`;
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
  activeOffsetX = guidedOffsetX;
  activeOffsetY = guidedOffsetY;
  const returnX = currentX;
  const returnY = currentY;

  try {
    setStatus(`Guided tour started for ${software}.`);

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (!step || typeof step.x !== "number" || typeof step.y !== "number") {
        continue;
      }

      await moveCursorTo(step.x, step.y);

      const needsClick = Boolean(step.click);
      const actionLabel = needsClick ? "Click here" : "Look here";
      setStatus(`${actionLabel}<br />${step.text || "Review this area."}`);
      showTooltip(buildStepTooltip(step, i, steps.length));
      await sleep(900);
      if (needsClick) {
        showClickCue(step.x, step.y);
      }
      await speakStep(buildNaturalStepSpeech(step, i, steps.length));
      await sleep(180);
    }

    setStatus(`Returning cursor to its original position...`);
    await moveCursorTo(returnX, returnY, 2400);
    await sleep(220);
    setStatus(`Guided tour finished for ${software}. Press Ctrl+Shift+V for another command.`);
  } catch (error) {
    setStatus(`Guided tour issue: ${error.message}`);
    await moveCursorTo(returnX, returnY, 2400).catch(() => {});
  } finally {
    hideTooltip();
    isGuidedTourRunning = false;
    isGuidedControlActive = false;
    activeOffsetX = followOffsetX;
    activeOffsetY = followOffsetY;
  }
});

setInterval(() => {
  void refreshScreenContext();
}, captureIntervalMs);

function animate() {
  currentX += (targetX - currentX) * 0.13;
  currentY += (targetY - currentY) * 0.13;

  renderCursor();
  window.requestAnimationFrame(animate);
}

window.requestAnimationFrame(animate);
