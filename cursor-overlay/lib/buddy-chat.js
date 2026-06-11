/* eslint-disable @typescript-eslint/no-require-imports */
const { getGroqTextApiKey } = require("./env");
const { getAssistantIdentityLine } = require("./assistant-identity");
const { GROQ_MODELS } = require("./groq-models");
const { sanitizeAssistantText } = require("./response-sanitizer");
const { detectResponseLanguage, getLanguageInstruction, normalizeTranscript } = require("./text-utils");

const CASUAL_PATTERNS = [
  /\b(how are you|how r you|what's up|whats up|sup)\b/,
  /\b(hello|hi|hey|yo)\b/,
  /\b(thank you|thanks|thx)\b/,
  /\b(good morning|good afternoon|good evening|good night)\b/,
  /\b(are you there|can you hear me|you there)\b/,
  /\b(i am bored|i'm bored|im bored)\b/,
  /\b(nice|cool|awesome|great|okay|ok)\b/,
  /\b(say|tell|greet|wish|shout out)\b.+\b(to|for)\b/,
  /\b(can you|could you|please)\b.+\b(say|tell|greet|wish|shout out)\b/,
  /\b(i am|i'm|im)\b.+\b(on|in|live|streaming|recording)\b/,
  /\b(kaise ho|kya haal|kya scene|sun rahe ho|suno|namaste|salaam|assalam|shukriya|dhanyavaad)\b/,
  /(कैसे हो|क्या हाल|नमस्ते|शुक्रिया|धन्यवाद|सुन रहे हो)/,
  /(کیسے ہو|کیا حال|سلام|شکریہ|سن رہے ہو)/,
];

function extractBuddyChatIntent(transcript) {
  const responseLanguage = detectResponseLanguage(transcript);
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\p{L}\p{M}\p{N}\s?']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  if (/\b(open|launch|start|search|find|play|change|set|turn|make cursor|go to|explain)\b/.test(normalized)) {
    return null;
  }

  if (CASUAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { message: String(transcript || "").trim(), responseLanguage };
  }

  return null;
}

async function answerBuddyChat(intent) {
  const responseLanguage = intent?.responseLanguage || detectResponseLanguage(intent?.message || "");
  const fallback = answerBuddyChatFallback(intent?.message || "");
  if (isDirectSpeechRequest(intent?.message || "")) {
    return fallback;
  }

  const apiKey = getGroqTextApiKey();
  if (!apiKey) {
    return fallback;
  }

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODELS.buddyChat,
        temperature: 0.65,
        messages: [
          {
            role: "system",
            content:
              `You are ${getAssistantIdentityLine()} ${getLanguageInstruction(responseLanguage)} Output ONLY the final spoken reply. Do not include reasoning, analysis, labels, quoted user text, or phrases like 'the user is asking'. Do not claim to browse the web. Do not mention URLs or commands unless the user asks.`,
          },
          {
            role: "user",
            content: intent?.message || "",
          },
        ],
      }),
    });

    if (!response.ok) {
      return fallback;
    }

    const data = await response.json();
    return sanitizeAssistantText(data.choices?.[0]?.message?.content, fallback).slice(0, 180);
  } catch {
    return fallback;
  }
}

function answerBuddyChatFallback(message) {
  const normalized = normalizeTranscript(message);
  const responseLanguage = detectResponseLanguage(message);

  const directSpeech = buildDirectSpeechReply(message);
  if (directSpeech) {
    return directSpeech;
  }

  if (responseLanguage === "hindi") {
    if (/\b(how are you|how r you|kaise ho)\b/.test(normalized) || /(कैसे हो|क्या हाल)/.test(normalized)) {
      return "मैं बढ़िया हूँ. बताओ, क्या करना है?";
    }
    if (/(नमस्ते|हेलो|हाय)/.test(normalized)) {
      return "नमस्ते. मैं यहीं हूँ.";
    }
    if (/(शुक्रिया|धन्यवाद)/.test(normalized)) {
      return "हमेशा. मैं हूँ ना.";
    }
    return "मैं यहीं हूँ. बताओ, क्या चल रहा है?";
  }

  if (responseLanguage === "urdu") {
    if (/(کیسے ہو|کیا حال)/.test(normalized)) {
      return "میں اچھی ہوں. بتائیں، کیا کرنا ہے؟";
    }
    if (/(سلام|ہیلو|ہائے)/.test(normalized)) {
      return "سلام. میں یہیں ہوں.";
    }
    if (/(شکریہ|مہربانی)/.test(normalized)) {
      return "ہمیشہ. میں ہوں نا.";
    }
    return "میں یہیں ہوں. بتائیں، کیا چل رہا ہے؟";
  }

  if (responseLanguage === "hinglish") {
    if (/\b(how are you|how r you|kaise ho|kya haal)\b/.test(normalized)) {
      return "Main mast hoon. Batao, kya karna hai?";
    }
    if (/\b(namaste|salaam|hi|hello|hey)\b/.test(normalized)) {
      return "Hey, main yahin hoon.";
    }
    if (/\b(shukriya|dhanyavaad|thanks|thank you)\b/.test(normalized)) {
      return "Always. Main hoon na.";
    }
    return "Main yahin hoon. Batao, kya scene hai?";
  }

  if (/\b(how are you|how r you)\b/.test(normalized)) {
    return "I'm doing good, honestly. Ready whenever you are.";
  }
  if (/\b(what's up|whats up|sup)\b/.test(normalized)) {
    return "Not much, just hanging here with you. What's the move?";
  }
  if (/\b(thank you|thanks|thx)\b/.test(normalized)) {
    return "Anytime. I got you.";
  }
  if (/\b(good morning)\b/.test(normalized)) {
    return "Good morning. Let's make today smooth.";
  }
  if (/\b(good afternoon)\b/.test(normalized)) {
    return "Good afternoon. I'm here and ready.";
  }
  if (/\b(good evening)\b/.test(normalized)) {
    return "Good evening. What are we working on?";
  }
  if (/\b(good night)\b/.test(normalized)) {
    return "Good night. Rest easy.";
  }
  if (/\b(are you there|can you hear me|you there)\b/.test(normalized)) {
    return "Yep, L.A.R.V.I.S. is right here.";
  }
  if (/\b(i am bored|i'm bored|im bored)\b/.test(normalized)) {
    return "Fair. Want me to help you find something interesting to do?";
  }

  return "L.A.R.V.I.S. is here with you. Tell me what's on your mind.";
}

function isDirectSpeechRequest(message) {
  const normalized = normalizeTranscript(message);
  return /\b(say|tell|greet|wish|shout out)\b/.test(normalized) && /\b(to|for)\b/.test(normalized);
}

function buildDirectSpeechReply(message) {
  const normalized = normalizeTranscript(message);
  const quoted = String(message || "").match(/['"]([^'"]{1,120})['"]/);
  const target = extractSpeechTarget(normalized);

  if (/\b(say|greet|shout out)\b/.test(normalized) && /\b(subscribers|chat|audience|viewers|followers|everyone)\b/.test(normalized)) {
    return quoted?.[1] ? `${sentenceCase(quoted[1])}, everyone.` : "Hi everyone. Hope you're all doing great.";
  }

  if (quoted?.[1] && target) {
    return `${sentenceCase(quoted[1])}, ${formatSpeechTarget(target)}.`;
  }

  if (/\b(say|greet|shout out)\b/.test(normalized) && target) {
    return `Hey ${formatSpeechTarget(target)}. Hope you're doing great.`;
  }

  return "";
}

function extractSpeechTarget(normalized) {
  const targetMatch = normalized.match(/\b(?:to|for)\s+(my\s+)?([a-z0-9\s]{1,40})$/);
  if (!targetMatch?.[2]) {
    return "";
  }

  return targetMatch[2]
    .replace(/\b(please|now|buddy)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceCase(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "";
  }
  return clean[0].toUpperCase() + clean.slice(1);
}

function formatSpeechTarget(target) {
  const clean = String(target || "").replace(/\s+/g, " ").trim();
  if (clean.toLowerCase() === "x") {
    return "X";
  }
  return clean;
}

module.exports = {
  answerBuddyChat,
  extractBuddyChatIntent,
};
