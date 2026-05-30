/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");
const { exec, execFile } = require("child_process");
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } = require("electron");

let overlayWindow = null;
let tickInterval = null;
let latestCursorPoint = { x: 0, y: 0 };

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

function getGoogleTtsApiKey() {
  return (
    process.env.GOOGLE_TTS_API_KEY ||
    readEnvValue("GOOGLE_TTS_API_KEY") ||
    process.env.GOOGLE_API_KEY ||
    readEnvValue("GOOGLE_API_KEY")
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
  const googleTtsApiKey = getGoogleTtsApiKey();
  if (!googleTtsApiKey) {
    return { ok: false, reason: "GOOGLE_TTS_API_KEY is missing." };
  }

  const spokenText = safeVoiceText(text);
  if (!spokenText) {
    return { ok: false, reason: "No text available to speak." };
  }

  const outputFile = path.join(app.getPath("temp"), `ai-buddy-${Date.now()}.wav`);
  const response = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(googleTtsApiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: {
        text: spokenText,
      },
      voice: {
        languageCode: "en-US",
        name: "en-US-Neural2-C",
      },
      audioConfig: {
        audioEncoding: "LINEAR16",
        speakingRate: 1,
        pitch: 0,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, reason: `Google TTS failed (${response.status}): ${body}` };
  }

  const data = await response.json();
  if (!data.audioContent) {
    return { ok: false, reason: "Google TTS returned no audio content." };
  }

  await fs.promises.writeFile(outputFile, Buffer.from(data.audioContent, "base64"));

  await new Promise((resolve, reject) => {
    const playScript = `
try {
  $player = New-Object System.Media.SoundPlayer '${outputFile.replace(/\\/g, "\\\\")}'
  $player.PlaySync()
  Write-Output "OK"
} catch {
  Write-Output "ERR"
}
`;

    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", playScript],
      { windowsHide: true, timeout: 30000 },
      (error, stdout) => {
        if (error || String(stdout || "").trim() !== "OK") {
          reject(error || new Error("Audio playback failed."));
          return;
        }

        resolve();
      },
    );
  });

  fs.promises.unlink(outputFile).catch(() => {});
  return { ok: true };
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
    "You are an assistant that returns strict JSON only. Choose one action from: open_notepad, open_calculator, open_vscode, search_web, open_website, none. Return keys: action, argument, reply.";

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

function executePlannedAction(plan) {
  const action = (plan?.action || "none").toString();
  const argument = (plan?.argument || "").toString().trim();

  if (action === "open_notepad") {
    runCommand("start notepad");
    return "Opening Notepad.";
  }

  if (action === "open_calculator") {
    runCommand("start calc");
    return "Opening Calculator.";
  }

  if (action === "open_vscode") {
    runCommand("start code");
    return "Opening VS Code.";
  }

  if (action === "search_web" && argument) {
    shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(argument)}`);
    return `Searching for ${argument}.`;
  }

  if (action === "open_website" && argument) {
    const fullUrl = argument.startsWith("http") ? argument : `https://${argument}`;
    shell.openExternal(fullUrl);
    return `Opening ${fullUrl}.`;
  }

  return plan?.reply || "I understood you, but no safe action was executed.";
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

  return "I heard you, but that command is not in the current safe command set yet.";
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

      try {
        const plan = await planActionWithGroq(transcript, payload);
        message = executePlannedAction(plan);
      } catch {
        message = executeVoiceCommandFallback(transcript);
      }

      const speechResult = await speakWithCloudTts(message);
      const finalMessage = speechResult.ok ? message : `${message} (TTS unavailable: ${speechResult.reason})`;

      return {
        ok: true,
        transcript,
        message: finalMessage,
      };
    } catch (error) {
      const fallbackErrorMessage = `Voice pipeline error: ${error.message}`;
      await speakWithCloudTts(fallbackErrorMessage).catch(() => {});
      return {
        ok: false,
        transcript: "",
        message: fallbackErrorMessage,
      };
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
