/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("path");
const { exec } = require("child_process");
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require("electron");
const {
  createBrowserCommandRunner,
  extractBrowserTaskIntent,
  extractGenericOpenWebsiteIntent,
} = require("./lib/browser-commands");
const { createActionExecutor } = require("./lib/action-executor");
const {
  planActionWithGroq,
  planVisualElementLocationWithGroq,
  planVisualGuidedTourWithGroq,
  speakWithCloudTts,
  transcribeWithGroq,
} = require("./lib/cloud-ai");
const { createGuidedTourController } = require("./lib/guided-tour");
const { buildReply } = require("./lib/reply-builder");
const { normalizeTranscript } = require("./lib/text-utils");

let overlayWindow = null;
let tickInterval = null;
let latestCursorPoint = { x: 0, y: 0 };
let overlayBounds = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function runCommand(command) {
  exec(command, { windowsHide: true });
}

const browserCommands = createBrowserCommandRunner(shell);
const actionExecutor = createActionExecutor({
  browserCommands,
  extractBrowserTaskIntent,
  extractGenericOpenWebsiteIntent,
  runCommand,
  shell,
});
const guidedTour = createGuidedTourController({
  getOverlayBounds: () => overlayBounds,
  getOverlayWindow: () => overlayWindow,
  planVisualElementLocation: planVisualElementLocationWithGroq,
  planVisualGuidedTour: planVisualGuidedTourWithGroq,
});

function getVirtualBounds() {
  const displays = screen.getAllDisplays();

  const left = Math.min(...displays.map((display) => display.bounds.x));
  const top = Math.min(...displays.map((display) => display.bounds.y));
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

function createOverlay() {
  const bounds = getVirtualBounds();
  overlayBounds = bounds;

  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
    },
  });

  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });

  overlayWindow.loadFile(path.join(__dirname, "overlay.html"));

  tickInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    const point = screen.getCursorScreenPoint();
    latestCursorPoint = point;
    overlayWindow.webContents.send("cursor:position", {
      x: point.x - bounds.x,
      y: point.y - bounds.y,
    });
  }, 8);
}

async function resolveVoiceAction(transcript, payload) {
  const directBrowserTask = extractBrowserTaskIntent(transcript);
  if (directBrowserTask) {
    return { message: await browserCommands.openBrowserTask(directBrowserTask) };
  }

  const directGenericWebsite = extractGenericOpenWebsiteIntent(transcript);
  if (directGenericWebsite) {
    return { message: browserCommands.openGenericWebsite(directGenericWebsite) };
  }

  const plan = await planActionWithGroq(transcript, payload);
  return actionExecutor.executePlannedAction(plan);
}

async function handleVoiceCommand(payload) {
  const transcript = await transcribeWithGroq(payload?.audioBase64 || "", payload?.mimeType || "audio/webm");

  if (!transcript) {
    return {
      ok: false,
      transcript: "",
      message: "No speech was detected in the audio clip.",
    };
  }

  let message = "";
  let suppressFinalTts = false;
  let shouldStartGuidedTour = false;
  let softwareName = "";
  let shouldLocateElement = false;
  let elementName = "";

  try {
    const actionResult = await resolveVoiceAction(transcript, payload);
    message = actionResult.message;
    suppressFinalTts = Boolean(actionResult.suppressFinalTts);
    shouldStartGuidedTour = Boolean(actionResult.shouldStartGuidedTour);
    softwareName = String(actionResult.softwareName || "");
    shouldLocateElement = Boolean(actionResult.shouldLocateElement);
    elementName = String(actionResult.elementName || "");
  } catch {
    message = await actionExecutor.executeVoiceCommandFallback(transcript);
    if (normalizeTranscript(transcript).startsWith("explain")) {
      shouldStartGuidedTour = true;
      softwareName = normalizeTranscript(transcript).replace("explain", "").trim() || "this software";
      suppressFinalTts = true;
    }
  }

  if (shouldLocateElement) {
    const located = await guidedTour.startElementLocationTour(elementName, payload);
    if (!located) {
      suppressFinalTts = false;
      message = buildReply("notFound", { target: elementName });
    } else {
      message = buildReply("located", { target: elementName });
    }
  }

  if (shouldStartGuidedTour) {
    const started = await guidedTour.startSoftwareGuidedTour(softwareName, payload);
    if (!started) {
      suppressFinalTts = false;
      message = `I can explain ${softwareName || "this software"}, but I could not start the walkthrough right now.`;
    }
  }

  const speechResult = suppressFinalTts ? { ok: false, reason: "Skipped in guided tour mode." } : await speakWithCloudTts(message);
  const finalMessage = suppressFinalTts
    ? message
    : speechResult.ok
      ? message
      : `${message} (TTS unavailable: ${speechResult.reason})`;

  return {
    ok: true,
    transcript,
    message: finalMessage,
    tts: speechResult.ok
      ? {
          audioBase64: speechResult.audioBase64,
          mimeType: speechResult.mimeType,
        }
      : null,
  };
}

function registerIpcHandlers() {
  ipcMain.handle("assistant:cursor-context", () => {
    return {
      x: latestCursorPoint.x,
      y: latestCursorPoint.y,
      capturedAt: new Date().toISOString(),
    };
  });

  ipcMain.handle("assistant:listen-and-execute", async (_event, payload) => {
    try {
      return await handleVoiceCommand(payload);
    } catch (error) {
      const fallbackErrorMessage = `Voice pipeline error: ${error.message}`;
      const speechResult = await speakWithCloudTts(fallbackErrorMessage).catch(() => ({ ok: false }));
      return {
        ok: false,
        transcript: "",
        message: fallbackErrorMessage,
        tts:
          speechResult.ok && speechResult.audioBase64
            ? {
                audioBase64: speechResult.audioBase64,
                mimeType: speechResult.mimeType,
              }
            : null,
      };
    }
  });

  ipcMain.handle("assistant:speak-text", async (_event, text) => {
    try {
      const speechResult = await speakWithCloudTts(String(text || ""));
      if (!speechResult.ok) {
        return { ok: false, reason: speechResult.reason };
      }
      return {
        ok: true,
        audioBase64: speechResult.audioBase64,
        mimeType: speechResult.mimeType,
      };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  });
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+V", () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    overlayWindow.webContents.send("assistant:toggle-listening");
  });

  globalShortcut.register("CommandOrControl+Shift+X", () => {
    app.quit();
  });
}

app.whenReady().then(() => {
  createOverlay();
  registerIpcHandlers();
  registerShortcuts();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();

  if (tickInterval) {
    clearInterval(tickInterval);
  }
});
