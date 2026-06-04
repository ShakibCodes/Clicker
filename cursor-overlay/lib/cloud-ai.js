/* eslint-disable @typescript-eslint/no-require-imports */
const {
  getElevenLabsApiKey,
  getElevenLabsModelId,
  getElevenLabsVoiceId,
  getGeminiApiKey,
  getGeminiTtsModelIds,
  getGeminiTtsVoiceName,
  getGroqSpeechApiKey,
  getGroqTextApiKey,
} = require("./env");
const { GROQ_MODELS } = require("./groq-models");
const { sanitizeAssistantText } = require("./response-sanitizer");

function safeVoiceText(input) {
  return sanitizeAssistantText(input)
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 450);
}

async function speakWithCloudTts(text) {
  const spokenText = safeVoiceText(text);
  if (!spokenText) {
    return { ok: false, reason: "No text available to speak." };
  }

  const elevenLabsResult = await speakWithElevenLabs(spokenText);
  if (elevenLabsResult.ok || !shouldFallbackToGemini(elevenLabsResult)) {
    return elevenLabsResult;
  }

  const geminiResult = await speakWithGeminiTts(spokenText);
  if (geminiResult.ok) {
    return {
      ...geminiResult,
      fallbackFrom: "elevenlabs",
      fallbackReason: elevenLabsResult.reason,
    };
  }

  return {
    ok: false,
    reason: `${elevenLabsResult.reason}; Gemini fallback failed: ${geminiResult.reason}`,
  };
}

async function speakWithElevenLabs(spokenText) {
  const elevenLabsApiKey = getElevenLabsApiKey();
  if (!elevenLabsApiKey) {
    return { ok: false, reason: "ELEVENLABS_API_KEY is missing." };
  }

  const voiceId = getElevenLabsVoiceId();
  const modelId = getElevenLabsModelId();
  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": elevenLabsApiKey,
    },
    body: JSON.stringify({
      text: spokenText,
      model_id: modelId,
      voice_settings: {
        stability: 0.34,
        similarity_boost: 0.76,
        style: 0.48,
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
    provider: "elevenlabs",
  };
}

async function speakWithGeminiTts(spokenText) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    return { ok: false, reason: "GEMINI_API_KEY is missing." };
  }

  const modelIds = getGeminiTtsModelIds();
  const errors = [];
  for (const modelId of modelIds) {
    const result = await speakWithGeminiTtsModel(spokenText, {
      apiKey,
      modelId,
    });
    if (result.ok) {
      return result;
    }

    errors.push(`${modelId}: ${result.reason}`);
    if (!shouldFallbackToNextGeminiModel(result)) {
      break;
    }
  }

  return {
    ok: false,
    reason: errors.join(" | ") || "Gemini TTS failed.",
  };
}

async function speakWithGeminiTtsModel(spokenText, options) {
  const modelId = options.modelId;
  const apiKey = options.apiKey;
  const voiceName = getGeminiTtsVoiceName();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Say naturally, warmly, and clearly: ${spokenText}`,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        },
      },
      model: modelId,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return { ok: false, reason: `Gemini TTS failed (${response.status}): ${body}` };
  }

  const data = await response.json();
  const inlineAudio = data.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  const pcmBase64 = inlineAudio?.data || "";
  if (!pcmBase64) {
    return { ok: false, reason: "Gemini TTS returned no audio." };
  }

  const pcmBuffer = Buffer.from(pcmBase64, "base64");
  const wavBuffer = wrapPcmAsWav(pcmBuffer);
  return {
    ok: true,
    audioBase64: wavBuffer.toString("base64"),
    mimeType: "audio/wav",
    provider: "gemini",
    providerModel: modelId,
  };
}

function shouldFallbackToGemini(result) {
  const reason = String(result?.reason || "").toLowerCase();
  return (
    reason.includes("missing") ||
    reason.includes("401") ||
    reason.includes("402") ||
    reason.includes("403") ||
    reason.includes("429") ||
    reason.includes("quota") ||
    reason.includes("credit") ||
    reason.includes("limit") ||
    reason.includes("billing")
  );
}

function shouldFallbackToNextGeminiModel(result) {
  const reason = String(result?.reason || "").toLowerCase();
  return (
    reason.includes("429") ||
    reason.includes("quota") ||
    reason.includes("rate") ||
    reason.includes("resource_exhausted") ||
    reason.includes("exceeded") ||
    reason.includes("limit")
  );
}

function wrapPcmAsWav(pcmBuffer, options = {}) {
  const channels = options.channels || 1;
  const sampleRate = options.sampleRate || 24000;
  const bitsPerSample = options.bitsPerSample || 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
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
  formData.append("model", GROQ_MODELS.transcription);
  formData.append("file", file);
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
    "You are an assistant that returns strict JSON only. The user may speak English, Hindi, Urdu, or Hinglish. Choose one action from: open_notepad, open_calculator, open_vscode, search_web, open_website, locate_ui_element, explain_software, none. Return keys: action, argument, reply. Use current on-screen context first. If user asks to find/locate/show a button, tab, panel, menu, icon, or control, choose locate_ui_element and put only that target name in argument. Choose explain_software only when user explicitly asks for tutorial/guide/walkthrough/explain entire software.";

  const screenUnderstanding = await summarizeScreenContextWithGroq(context?.screenFrame).catch(() => "");

  const userPrompt = JSON.stringify({
    transcript,
    cursor: context?.cursorContext || null,
    hasScreenFrame: Boolean(context?.screenFrame),
    screenUnderstanding,
  });

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODELS.commandPlanner,
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

async function summarizeScreenContextWithGroq(screenFrame) {
  const apiKey = getGroqTextApiKey();
  const dataUrl = String(screenFrame || "");
  if (!apiKey || !dataUrl.startsWith("data:image")) {
    return "";
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODELS.screenVision,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Return plain text only, max 80 words. Identify likely app/window and prominent controls/regions currently visible.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize what software window is visible and key actionable UI controls." },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    return "";
  }

  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
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
      model: GROQ_MODELS.screenVision,
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
  const screenUnderstanding = await summarizeScreenContextWithGroq(screenFrame).catch(() => "");
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
      model: GROQ_MODELS.screenVision,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return strict JSON only with shape: {x:number,y:number,text:string,click:boolean,confidence:number}. x and y are normalized between 0 and 1 and must pinpoint the exact clickable center of the requested UI target visible in the screenshot. Prefer exact clickable hotspots over nearby labels. If VS Code is visible and target is run button, prioritize Run and Debug activity-bar icon OR top Run menu. If not visible, set confidence to 0 and text to a short reason.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Find this UI target in the current visible window and pinpoint it exactly: ${targetName}. Screen understanding: ${screenUnderstanding || "unknown"}`,
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

module.exports = {
  _test: {
    shouldFallbackToNextGeminiModel,
    shouldFallbackToGemini,
    wrapPcmAsWav,
  },
  planActionWithGroq,
  planVisualElementLocationWithGroq,
  planVisualGuidedTourWithGroq,
  speakWithCloudTts,
  transcribeWithGroq,
};
