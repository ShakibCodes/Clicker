/* eslint-disable @typescript-eslint/no-require-imports */
const { getGroqTextApiKey } = require("./env");
const { normalizeTranscript } = require("./text-utils");

const QUESTION_STARTERS = [
  "what",
  "who",
  "when",
  "where",
  "why",
  "how",
  "which",
  "tell me",
  "explain",
  "give me",
  "find out",
  "look up",
  "search about",
];

const CURRENT_TERMS = [
  "latest",
  "today",
  "current",
  "recent",
  "news",
  "update",
  "updates",
  "now",
  "this week",
  "this month",
];

const CASUAL_QUESTIONS = [
  /\bhow are you\b/,
  /\bhow r you\b/,
  /\bwhat's up\b/,
  /\bwhats up\b/,
  /\byou there\b/,
  /\bcan you hear me\b/,
];

function extractWebKnowledgeIntent(transcript) {
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\w\s?.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  if (CASUAL_QUESTIONS.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  if (/\b(open|launch|start|play|change|set|turn|make cursor|go to)\b/.test(normalized)) {
    return null;
  }

  const looksLikeQuestion =
    normalized.endsWith("?") ||
    QUESTION_STARTERS.some((starter) => normalized.startsWith(starter)) ||
    CURRENT_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(normalized));

  if (!looksLikeQuestion) {
    return null;
  }

  return {
    query: normalized.replace(/\?+$/g, "").trim(),
    needsFreshSources: CURRENT_TERMS.some((term) => new RegExp(`\\b${term}\\b`).test(normalized)),
  };
}

async function answerWebKnowledgeQuestion(intent) {
  const query = buildSearchQuery(intent);
  const searchResults = await searchDuckDuckGo(query);
  const sourceTexts = await collectSourceTexts(searchResults);

  if (sourceTexts.length === 0) {
    return "I tried checking the web, but I could not get reliable source text for that right now.";
  }

  return summarizeWithGroq(intent.query, sourceTexts);
}

function buildSearchQuery(intent) {
  if (!intent?.needsFreshSources) {
    return intent.query;
  }

  const today = new Date().toISOString().slice(0, 10);
  return `${intent.query} ${today}`;
}

async function searchDuckDuckGo(query) {
  const response = await fetch(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Web search failed (${response.status}).`);
  }

  const html = await response.text();
  const results = [];
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match = resultRegex.exec(html);

  while (match && results.length < 5) {
    const url = normalizeSearchResultUrl(decodeHtml(match[1]));
    const title = decodeHtml(stripHtml(match[2]));
    if (url && title && !results.some((result) => result.url === url)) {
      results.push({ title, url });
    }
    match = resultRegex.exec(html);
  }

  return results;
}

function normalizeSearchResultUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    return redirected || url.href;
  } catch {
    return "";
  }
}

async function collectSourceTexts(searchResults) {
  const sourceTexts = [];

  for (const result of searchResults.slice(0, 4)) {
    const text = await fetchReadableText(result.url).catch(() => "");
    if (!text || text.length < 240) {
      continue;
    }

    sourceTexts.push({
      title: result.title,
      url: result.url,
      text: text.slice(0, 3200),
    });
  }

  return sourceTexts;
}

async function fetchReadableText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      return "";
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      return "";
    }

    const raw = await response.text();
    return stripHtml(raw)
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeWithGroq(question, sourceTexts) {
  const apiKey = getGroqTextApiKey();
  if (!apiKey) {
    throw new Error("Missing GROQ_AI_API_FOR_TEXT in .env.local or environment.");
  }

  const sourceBlock = sourceTexts
    .map((source, index) => `Source ${index + 1}: ${source.title}\nURL: ${source.url}\nText: ${source.text}`)
    .join("\n\n");

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      temperature: 0.12,
      messages: [
        {
          role: "system",
          content:
            "Answer like a concise voice assistant. Use only the provided web sources. If sources are weak or disagree, say that briefly. Keep it under 90 words. Do not mention URLs.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\nWeb sources:\n${sourceBlock}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq web answer failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const answer = String(data.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim();
  return answer || "I checked the web, but I could not form a reliable answer from the sources.";
}

function stripHtml(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

module.exports = {
  answerWebKnowledgeQuestion,
  extractWebKnowledgeIntent,
};
