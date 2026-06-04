/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

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

function getElevenLabsModelId() {
  return (
    process.env.ELEVENLABS_MODEL_ID ||
    readEnvValue("ELEVENLABS_MODEL_ID") ||
    "eleven_multilingual_v2"
  );
}

function getGoogleOAuthClientId() {
  return process.env.GOOGLE_OAUTH_CLIENT_ID || readEnvValue("GOOGLE_OAUTH_CLIENT_ID");
}

function getGoogleOAuthClientSecret() {
  return process.env.GOOGLE_OAUTH_CLIENT_SECRET || readEnvValue("GOOGLE_OAUTH_CLIENT_SECRET");
}

function getGeminiApiKey() {
  return process.env.GEMINI_API_KEY || readEnvValue("GEMINI_API_KEY") || process.env.GOOGLE_AI_API_KEY || readEnvValue("GOOGLE_AI_API_KEY");
}

function getGeminiTtsModelId() {
  return process.env.GEMINI_TTS_MODEL_ID || readEnvValue("GEMINI_TTS_MODEL_ID") || "gemini-3.1-flash-tts-preview";
}

function getGeminiTtsModelIds() {
  const configuredModels = process.env.GEMINI_TTS_MODEL_IDS || readEnvValue("GEMINI_TTS_MODEL_IDS");
  const models = configuredModels
    ? configuredModels
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean)
    : [getGeminiTtsModelId(), "gemini-2.5-flash-preview-tts"];

  return Array.from(new Set(models));
}

function getGeminiTtsVoiceName() {
  return process.env.GEMINI_TTS_VOICE_NAME || readEnvValue("GEMINI_TTS_VOICE_NAME") || "Kore";
}

module.exports = {
  getElevenLabsApiKey,
  getElevenLabsModelId,
  getElevenLabsVoiceId,
  getGeminiApiKey,
  getGeminiTtsModelId,
  getGeminiTtsModelIds,
  getGeminiTtsVoiceName,
  getGoogleOAuthClientId,
  getGoogleOAuthClientSecret,
  getGroqSpeechApiKey,
  getGroqTextApiKey,
};
