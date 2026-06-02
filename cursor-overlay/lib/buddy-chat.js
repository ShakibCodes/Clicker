/* eslint-disable @typescript-eslint/no-require-imports */
const { getGroqTextApiKey } = require("./env");
const { normalizeTranscript } = require("./text-utils");

const CASUAL_PATTERNS = [
  /\b(how are you|how r you|what's up|whats up|sup)\b/,
  /\b(hello|hi|hey|yo)\b/,
  /\b(thank you|thanks|thx)\b/,
  /\b(good morning|good afternoon|good evening|good night)\b/,
  /\b(are you there|can you hear me|you there)\b/,
  /\b(i am bored|i'm bored|im bored)\b/,
  /\b(nice|cool|awesome|great|okay|ok)\b/,
];

function extractBuddyChatIntent(transcript) {
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\w\s?']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  if (/\b(open|launch|start|search|find|play|change|set|turn|make cursor|go to|explain)\b/.test(normalized)) {
    return null;
  }

  if (CASUAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { message: normalized };
  }

  return null;
}

async function answerBuddyChat(intent) {
  const fallback = answerBuddyChatFallback(intent?.message || "");
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
        model: "llama-3.1-8b-instant",
        temperature: 0.65,
        messages: [
          {
            role: "system",
            content:
              "You are AI Buddy, a warm, casual desktop voice companion. Reply naturally in one short sentence. Do not claim to browse the web. Do not mention URLs or commands unless the user asks.",
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
    return String(data.choices?.[0]?.message?.content || fallback)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  } catch {
    return fallback;
  }
}

function answerBuddyChatFallback(message) {
  const normalized = normalizeTranscript(message);

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
    return "Yep, I'm right here.";
  }
  if (/\b(i am bored|i'm bored|im bored)\b/.test(normalized)) {
    return "Fair. Want me to help you find something interesting to do?";
  }

  return "I'm here with you. Tell me what's on your mind.";
}

module.exports = {
  answerBuddyChat,
  extractBuddyChatIntent,
};
