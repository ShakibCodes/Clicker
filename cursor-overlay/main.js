/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("path");
const { exec } = require("child_process");
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require("electron");
const {
  createBrowserCommandRunner,
  extractBrowserTaskIntent,
  extractGenericOpenWebsiteIntent,
} = require("./lib/browser-commands");
const { answerBuddyChat } = require("./lib/buddy-chat");
const { createConversationContext } = require("./lib/conversation-context");
const { createConversationRouter } = require("./lib/conversation-router");
const { createActionExecutor } = require("./lib/action-executor");
const { createDecisionLog } = require("./lib/decision-log");
const { createGmailIntegration } = require("./lib/gmail-integration");
const { createGoogleAccountIntegration } = require("./lib/google-account-integration");
const { createGoogleCalendarIntegration } = require("./lib/google-calendar-integration");
const {
  getElevenLabsApiKey,
  getGeminiApiKey,
  getGeminiTtsModelId,
  getGeminiTtsModelIds,
  getGeminiTtsVoiceName,
} = require("./lib/env");
const {
  planActionWithGroq,
  planVisualElementLocationWithGroq,
  planVisualGuidedTourWithGroq,
  speakWithCloudTts,
  transcribeWithGroq,
} = require("./lib/cloud-ai");
const { applyCursorColor } = require("./lib/cursor-commands");
const { createGuidedTourController } = require("./lib/guided-tour");
const { buildReply } = require("./lib/reply-builder");
const { normalizeTranscript } = require("./lib/text-utils");
const { answerWebKnowledgeQuestion } = require("./lib/web-knowledge");

let overlayWindow = null;
let tickInterval = null;
let latestCursorPoint = { x: 0, y: 0 };
let overlayBounds = null;
let isNotchInteractive = false;
const conversationContext = createConversationContext();
const decisionLog = createDecisionLog();
const googleAccountIntegration = createGoogleAccountIntegration({
  getUserDataPath: () => app.getPath("userData"),
  shell,
});
const gmailIntegration = createGmailIntegration({
  googleAccount: googleAccountIntegration,
});
const calendarIntegration = createGoogleCalendarIntegration({
  googleAccount: googleAccountIntegration,
});

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
const conversationRouter = createConversationRouter({
  actionExecutor,
  answerBuddyChat,
  answerWebKnowledgeQuestion,
  applyCursorColor,
  browserCommands,
  calendarIntegration,
  conversationContext,
  decisionLog,
  gmailIntegration,
  overlayWindowProvider: () => overlayWindow,
  planAction: planActionWithGroq,
  speakInterim: speakInterimMessage,
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
  return conversationRouter.resolve(transcript, payload);
}

async function speakInterimMessage(message) {
  const speechResult = await speakWithCloudTts(message).catch(() => ({ ok: false }));
  if (speechResult.ok && speechResult.audioBase64) {
    overlayWindow?.webContents.send("assistant:play-tts", {
      audioBase64: speechResult.audioBase64,
      mimeType: speechResult.mimeType,
      statusText: message,
    });
    return;
  }

  overlayWindow?.webContents.send("assistant:status", {
    text: message,
  });
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
    rememberConversationTurn(transcript, actionResult);
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

function rememberConversationTurn(transcript, actionResult) {
  const memoryType = actionResult?.memoryType || "";
  if (memoryType !== "web" && memoryType !== "chat") {
    return;
  }

  conversationContext.remember({
    userText: transcript,
    answer: actionResult.message,
    topic: actionResult?.resolvedContext?.previous?.topic || "",
    type: memoryType,
  });
}

function registerIpcHandlers() {
  ipcMain.on("assistant:notch-interactive", (_event, nextState) => {
    const shouldInteract = Boolean(nextState);
    if (!overlayWindow || overlayWindow.isDestroyed() || isNotchInteractive === shouldInteract) {
      return;
    }

    isNotchInteractive = shouldInteract;
    overlayWindow.setIgnoreMouseEvents(!shouldInteract, { forward: true });
  });

  ipcMain.handle("assistant:cursor-context", () => {
    return {
      x: latestCursorPoint.x,
      y: latestCursorPoint.y,
      capturedAt: new Date().toISOString(),
    };
  });

  ipcMain.handle("assistant:decision-log", () => {
    return decisionLog.list();
  });

  ipcMain.handle("assistant:google-status", () => {
    return googleAccountIntegration.getStatus();
  });

  ipcMain.handle("assistant:google-connect", async () => {
    return googleAccountIntegration.connect();
  });

  ipcMain.handle("assistant:google-disconnect", () => {
    return googleAccountIntegration.disconnect();
  });

  ipcMain.handle("assistant:gmail-status", () => {
    return gmailIntegration.getStatus();
  });

  ipcMain.handle("assistant:gmail-connect", async () => {
    return gmailIntegration.connect();
  });

  ipcMain.handle("assistant:gmail-disconnect", () => {
    return gmailIntegration.disconnect();
  });

  ipcMain.handle("assistant:calendar-status", () => {
    return calendarIntegration.getStatus();
  });

  ipcMain.handle("assistant:calendar-connect", async () => {
    return calendarIntegration.connect();
  });

  ipcMain.handle("assistant:calendar-disconnect", () => {
    return calendarIntegration.disconnect();
  });

  ipcMain.handle("assistant:voice-status", () => {
    return {
      elevenLabsConfigured: Boolean(getElevenLabsApiKey()),
      fallbackProvider: "Gemini",
      fallbackReady: Boolean(getGeminiApiKey()),
      geminiModel: getGeminiTtsModelId(),
      geminiModels: getGeminiTtsModelIds(),
      geminiVoice: getGeminiTtsVoiceName(),
      primaryProvider: "ElevenLabs",
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
