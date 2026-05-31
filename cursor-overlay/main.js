/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require("electron");

let overlayWindow = null;
let tickInterval = null;
let latestCursorPoint = { x: 0, y: 0 };
let overlayBounds = null;

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

function readEnvValue(key) {
  const candidates = [
    path.join(process.cwd(), ".env.local"),
    path.join(process.cwd(), "..", ".env.local"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.startsWith(`${key}=`)) {
        continue;
      }

      const raw = trimmed.slice(key.length + 1).trim();
      if (!raw) {
        return "";
      }

      if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
        return raw.slice(1, -1);
      }

      return raw;
    }
  }

  return "";
}

function getGroqSpeechApiKey() {
  return (
    process.env.GROQ_AI_API_FOR_SPEECHTOTEXT ||
    readEnvValue("GROQ_AI_API_FOR_SPEECHTOTEXT") ||
    process.env.GROQ_API_KEY ||
    readEnvValue("GROQ_API_KEY")
  );
}

function getGroqTextApiKey() {
  return (
    process.env.GROQ_AI_API_FOR_TEXT ||
    readEnvValue("GROQ_AI_API_FOR_TEXT") ||
    process.env.GROQ_API_KEY ||
    readEnvValue("GROQ_API_KEY")
  );
}

function getElevenLabsApiKey() {
  return (
    process.env.ELEVENLABS_API_KEY ||
    readEnvValue("ELEVENLABS_API_KEY") ||
    process.env.ELEVEN_LABS_API_KEY ||
    readEnvValue("ELEVEN_LABS_API_KEY")
  );
}

function getElevenLabsVoiceId() {
  return (
    process.env.ELEVENLABS_VOICE_ID ||
    readEnvValue("ELEVENLABS_VOICE_ID") ||
    "EXAVITQu4vr4xnSDxMaL"
  );
}

function safeVoiceText(input) {
  return String(input || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 450);
}

async function speakWithCloudTts(text) {
  const elevenLabsApiKey = getElevenLabsApiKey();
  if (!elevenLabsApiKey) {
    return { ok: false, reason: "ELEVENLABS_API_KEY is missing." };
  }

  const spokenText = safeVoiceText(text);
  if (!spokenText) {
    return { ok: false, reason: "No text available to speak." };
  }

  const voiceId = getElevenLabsVoiceId();
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": elevenLabsApiKey,
    },
    body: JSON.stringify({
      text: spokenText,
      model_id: "eleven_turbo_v2_5",
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.15,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, reason: `ElevenLabs TTS failed (${response.status}): ${body}` };
  }

  const audioArrayBuffer = await response.arrayBuffer();
  return {
    ok: true,
    audioBase64: Buffer.from(audioArrayBuffer).toString("base64"),
    mimeType: "audio/mpeg",
  };
}

function runCommand(command) {
  exec(command, { windowsHide: true });
}

function normalizeTranscript(value) {
  return value.toLowerCase().trim();
}

async function transcribeWithGroq(audioBase64, mimeType) {
  const apiKey = getGroqSpeechApiKey();

  if (!apiKey) {
    throw new Error("Missing GROQ_AI_API_FOR_SPEECHTOTEXT in .env.local or environment.");
  }

  const audioBuffer = Buffer.from(audioBase64, "base64");
  const blob = new Blob([audioBuffer], { type: mimeType || "audio/webm" });
  const file = new File([blob], "voice.webm", { type: mimeType || "audio/webm" });

  const formData = new FormData();
  formData.append("model", "whisper-large-v3-turbo");
  formData.append("file", file);
  formData.append("language", "en");
  formData.append("temperature", "0");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq transcription failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.text || "").trim();
}

async function planActionWithGroq(transcript, context) {
  const apiKey = getGroqTextApiKey();

  if (!apiKey) {
    throw new Error("Missing GROQ_AI_API_FOR_TEXT in .env.local or environment.");
  }

  const systemPrompt =
    "You are an assistant that returns strict JSON only. Choose one action from: open_notepad, open_calculator, open_vscode, search_web, open_website, locate_ui_element, explain_software, none. Return keys: action, argument, reply. Use current on-screen context first. If user asks to find/locate/show a button, tab, panel, menu, icon, or control, choose locate_ui_element and put only that target name in argument. Choose explain_software only when user explicitly asks for tutorial/guide/walkthrough/explain entire software.";

  const userPrompt = JSON.stringify({
    transcript,
    cursor: context?.cursorContext || null,
    hasScreenFrame: Boolean(context?.screenFrame),
  });

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq planner failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  return JSON.parse(raw);
}

async function planVisualGuidedTourWithGroq(softwareName, context) {
  const apiKey = getGroqTextApiKey();
  const screenFrame = String(context?.screenFrame || "");

  if (!apiKey) {
    throw new Error("Missing GROQ_AI_API_FOR_TEXT in .env.local or environment.");
  }

  if (!screenFrame.startsWith("data:image")) {
    throw new Error("No recent screen frame is available for visual guided tour.");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return strict JSON only with shape: {steps:[{x:number,y:number,text:string,click:boolean}]}. x and y must be normalized between 0 and 1. click=true means user should click there now; click=false means informational pointing only. Based on the screenshot, identify key UI regions for explaining the target software and produce 4-7 concise steps.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Target software: ${softwareName}. Point to visible UI parts in this screenshot and explain each part. Keep step text short and practical.`,
            },
            {
              type: "image_url",
              image_url: {
                url: screenFrame,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq visual planner failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  const inputSteps = Array.isArray(parsed?.steps) ? parsed.steps : [];

  const steps = inputSteps
    .map((step) => ({
      x: Number(step?.x),
      y: Number(step?.y),
      text: String(step?.text || "").trim(),
      click: Boolean(step?.click),
    }))
    .filter((step) => Number.isFinite(step.x) && Number.isFinite(step.y) && step.x >= 0 && step.x <= 1 && step.y >= 0 && step.y <= 1)
    .slice(0, 7);

  if (steps.length === 0) {
    throw new Error("Visual guided planner returned no valid steps.");
  }

  return steps;
}

async function planVisualElementLocationWithGroq(targetName, context) {
  const apiKey = getGroqTextApiKey();
  const screenFrame = String(context?.screenFrame || "");
  if (!apiKey) {
    throw new Error("Missing GROQ_AI_API_FOR_TEXT in .env.local or environment.");
  }
  if (!screenFrame.startsWith("data:image")) {
    throw new Error("No recent screen frame is available for element location.");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return strict JSON only with shape: {x:number,y:number,text:string,click:boolean,confidence:number}. x and y are normalized between 0 and 1 and must pinpoint the exact clickable center of the requested UI target visible in the screenshot. If not visible, set confidence to 0 and text to a short reason.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Find this UI target in the current visible window and pinpoint it exactly: ${targetName}`,
            },
            {
              type: "image_url",
              image_url: {
                url: screenFrame,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq element locator failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);

  return {
    x: Number(parsed?.x),
    y: Number(parsed?.y),
    text: String(parsed?.text || "").trim(),
    click: Boolean(parsed?.click),
    confidence: Number(parsed?.confidence),
  };
}

function executePlannedAction(plan) {
  const action = (plan?.action || "none").toString();
  const argument = (plan?.argument || "").toString().trim();

  if (action === "open_notepad") {
    runCommand("start notepad");
    return { message: "Opening Notepad." };
  }

  if (action === "open_calculator") {
    runCommand("start calc");
    return { message: "Opening Calculator." };
  }

  if (action === "open_vscode") {
    runCommand("start code");
    return { message: "Opening VS Code." };
  }

  if (action === "search_web" && argument) {
    shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(argument)}`);
    return { message: `Searching for ${argument}.` };
  }

  if (action === "open_website" && argument) {
    const fullUrl = argument.startsWith("http") ? argument : `https://${argument}`;
    shell.openExternal(fullUrl);
    return { message: `Opening ${fullUrl}.` };
  }

  if (action === "explain_software") {
    return {
      message: `Starting a guided walkthrough of ${argument || "this software"}. Watch the secondary cursor as it points through the interface.`,
      suppressFinalTts: true,
      shouldStartGuidedTour: true,
      softwareName: argument || "this software",
    };
  }

  if (action === "locate_ui_element") {
    return {
      message: `Sure, I will point out ${argument || "that control"} in your current window.`,
      suppressFinalTts: true,
      shouldLocateElement: true,
      elementName: argument || "requested control",
    };
  }

  return { message: plan?.reply || "I understood you, but no safe action was executed." };
}

function executeVoiceCommandFallback(transcript) {
  const normalized = normalizeTranscript(transcript);

  if (normalized.includes("open notepad")) {
    runCommand("start notepad");
    return "Opening Notepad.";
  }

  if (normalized.includes("open calculator")) {
    runCommand("start calc");
    return "Opening Calculator.";
  }

  if (normalized.includes("open vscode") || normalized.includes("open vs code")) {
    runCommand("start code");
    return "Opening VS Code.";
  }

  if (normalized.startsWith("search for ")) {
    const query = normalized.replace("search for ", "").trim();
    shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
    return `Searching for ${query}.`;
  }

  if (normalized.startsWith("open website ")) {
    const url = normalized.replace("open website ", "").trim();
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;
    shell.openExternal(fullUrl);
    return `Opening ${fullUrl}.`;
  }

  if (normalized.startsWith("explain ")) {
    const softwareName = normalized.replace("explain ", "").replace("software", "").trim();
    return `Starting a guided walkthrough of ${softwareName || "this app"}.`;
  }

  return "I heard you, but that command is not in the current safe command set yet.";
}

function normalizeSoftwareName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^\w\s.+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTourTemplates(softwareName) {
  const name = normalizeSoftwareName(softwareName);
  const common = [
    { x: 0.05, y: 0.07, text: "Top-left area: this is usually where app identity, menus, or quick actions live.", click: false },
    { x: 0.5, y: 0.09, text: "Top bar: most software keeps global controls and context up here.", click: false },
    { x: 0.09, y: 0.28, text: "Left side: this zone often contains navigation, tools, or project shortcuts.", click: true },
    { x: 0.52, y: 0.43, text: "Center workspace: this is the main area where your core work happens.", click: false },
    { x: 0.77, y: 0.83, text: "Bottom-right area: this typically shows status, notifications, or utility actions.", click: true },
  ];

  if (name.includes("vscode") || name.includes("vs code") || name.includes("visual studio code")) {
    return [
      { x: 0.02, y: 0.26, text: "Activity Bar: switch between Explorer, Search, Source Control, Run, and Extensions.", click: true },
      { x: 0.15, y: 0.3, text: "Explorer panel: your file tree and folders live here for quick navigation.", click: true },
      { x: 0.5, y: 0.43, text: "Editor area: this is where you open and edit code files.", click: false },
      { x: 0.5, y: 0.08, text: "Tab and title zone: shows open files and editor context.", click: false },
      { x: 0.5, y: 0.95, text: "Status bar: Git branch, errors, formatter, and environment info appear here.", click: true },
    ];
  }

  if (name.includes("chrome") || name.includes("browser") || name.includes("edge") || name.includes("firefox")) {
    return [
      { x: 0.16, y: 0.08, text: "Tab row: open pages are shown here and can be reordered.", click: true },
      { x: 0.47, y: 0.13, text: "Address bar: type URLs, search queries, or browser commands here.", click: true },
      { x: 0.93, y: 0.13, text: "Profile and menu controls are usually grouped on the top-right.", click: true },
      { x: 0.5, y: 0.45, text: "Main content pane: this is the active webpage area.", click: false },
      { x: 0.04, y: 0.13, text: "Back, forward, and refresh controls let you navigate page history.", click: true },
    ];
  }

  return common;
}

async function startSoftwareGuidedTour(softwareName, context) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayBounds) {
    return false;
  }

  let normalizedSteps = [];
  try {
    normalizedSteps = await planVisualGuidedTourWithGroq(softwareName, context);
  } catch {
    normalizedSteps = buildTourTemplates(softwareName);
  }

  const steps = normalizedSteps.map((step) => ({
    x: Math.round(overlayBounds.width * step.x),
    y: Math.round(overlayBounds.height * step.y),
    text: step.text,
    click: Boolean(step.click),
  }));

  overlayWindow.webContents.send("assistant:guided-tour", {
    software: softwareName || "this software",
    steps,
  });

  return true;
}

async function startElementLocationTour(elementName, context) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayBounds) {
    return false;
  }

  const located = await planVisualElementLocationWithGroq(elementName, context).catch(() => null);
  const hasValidModelPoint =
    Boolean(located) &&
    Number.isFinite(located.x) &&
    Number.isFinite(located.y) &&
    located.x >= 0 &&
    located.x <= 1 &&
    located.y >= 0 &&
    located.y <= 1;

  if (hasValidModelPoint) {
    overlayWindow.webContents.send("assistant:guided-tour", {
      software: "current window",
      steps: [
        {
          x: Math.round(overlayBounds.width * located.x),
          y: Math.round(overlayBounds.height * located.y),
          text: located.text || `This is the ${elementName}.`,
          click: true,
        },
      ],
    });
    return true;
  }

  const target = normalizeSoftwareName(elementName);
  if (target.includes("run")) {
    overlayWindow.webContents.send("assistant:guided-tour", {
      software: "VS Code",
      steps: [
        {
          x: Math.round(overlayBounds.width * 0.03),
          y: Math.round(overlayBounds.height * 0.46),
          text: "Run and Debug icon in the left Activity Bar.",
          click: true,
        },
      ],
    });
    return true;
  }

  return false;
}

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

  app.whenReady().then(() => {
  createOverlay();

  ipcMain.handle("assistant:cursor-context", () => {
    return {
      x: latestCursorPoint.x,
      y: latestCursorPoint.y,
      capturedAt: new Date().toISOString(),
    };
  });

  ipcMain.handle("assistant:listen-and-execute", async (_event, payload) => {
    try {
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
        const plan = await planActionWithGroq(transcript, payload);
        const actionResult = executePlannedAction(plan);
        message = actionResult.message;
        suppressFinalTts = Boolean(actionResult.suppressFinalTts);
        shouldStartGuidedTour = Boolean(actionResult.shouldStartGuidedTour);
        softwareName = String(actionResult.softwareName || "");
        shouldLocateElement = Boolean(actionResult.shouldLocateElement);
        elementName = String(actionResult.elementName || "");
      } catch {
        message = executeVoiceCommandFallback(transcript);
        if (normalizeTranscript(transcript).startsWith("explain")) {
          shouldStartGuidedTour = true;
          softwareName = normalizeTranscript(transcript).replace("explain", "").trim() || "this software";
          suppressFinalTts = true;
        }
      }

      if (shouldLocateElement) {
        const located = await startElementLocationTour(elementName, payload);
        if (!located) {
          suppressFinalTts = false;
          message = `I could not spot "${elementName}" clearly in this view. Keep it visible and ask me again, and I will point right to it.`;
        } else {
          message = `There it is. I just pointed to "${elementName}" in your current window.`;
        }
      }

      if (shouldStartGuidedTour) {
        const started = await startSoftwareGuidedTour(softwareName, payload);
        if (!started) {
          suppressFinalTts = false;
          message = `I can explain ${softwareName || "this software"}, but I could not start the on-screen guided tour right now.`;
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

  globalShortcut.register("CommandOrControl+Shift+V", () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    overlayWindow.webContents.send("assistant:toggle-listening");
  });

  globalShortcut.register("CommandOrControl+Shift+X", () => {
    app.quit();
  });
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
