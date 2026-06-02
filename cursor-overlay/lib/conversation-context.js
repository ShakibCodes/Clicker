/* eslint-disable @typescript-eslint/no-require-imports */
const { normalizeTranscript } = require("./text-utils");

const FOLLOW_UP_PRONOUNS = /\b(he|him|his|she|her|they|them|their|it|its|that|this|those|these)\b/;
const ENTITY_STOP_WORDS = new Set([
  "The",
  "A",
  "An",
  "This",
  "That",
  "It",
  "He",
  "She",
  "They",
  "In",
  "On",
  "At",
  "By",
  "As",
  "For",
  "With",
  "According",
]);

function createConversationContext() {
  let lastExchange = null;

  function remember(exchange) {
    const topic = extractTopic(exchange);
    lastExchange = {
      userText: String(exchange?.userText || "").trim(),
      answer: String(exchange?.answer || "").trim(),
      topic,
      savedAt: Date.now(),
      type: exchange?.type || "general",
    };
    return lastExchange;
  }

  function getLastExchange() {
    if (!lastExchange) {
      return null;
    }

    const ageMs = Date.now() - lastExchange.savedAt;
    if (ageMs > 10 * 60 * 1000) {
      return null;
    }

    return lastExchange;
  }

  function resolveFollowUp(text) {
    const normalized = normalizeTranscript(text);
    const previous = getLastExchange();
    if (!previous?.topic || !isFollowUpQuestion(normalized)) {
      return {
        query: String(text || "").trim(),
        previous,
        isFollowUp: false,
      };
    }

    return {
      query: `${String(text || "").trim()} ${previous.topic}`,
      previous,
      isFollowUp: true,
    };
  }

  return {
    getLastExchange,
    remember,
    resolveFollowUp,
  };
}

function isFollowUpQuestion(normalized) {
  if (!normalized) {
    return false;
  }

  return (
    FOLLOW_UP_PRONOUNS.test(normalized) ||
    /^(is|are|was|were|do|does|did|can|could|would|should|has|have|had)\b/.test(normalized) ||
    /\b(what about|how about|and)\b/.test(normalized)
  );
}

function extractTopic(exchange) {
  const explicitTopic = String(exchange?.topic || "").trim();
  if (explicitTopic) {
    return explicitTopic.slice(0, 120);
  }

  const answer = String(exchange?.answer || "");
  const userText = String(exchange?.userText || "");
  const fromAnswer = extractNamedEntity(answer);
  if (fromAnswer) {
    return fromAnswer;
  }

  return extractNamedEntity(userText);
}

function extractNamedEntity(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) {
    return "";
  }

  const mrBeast = clean.match(/\bMr\.?\s*Beast\b/i);
  if (mrBeast) {
    return "MrBeast";
  }

  const candidates = clean.match(/\b[A-Z][a-zA-Z0-9.'-]*(?:\s+[A-Z][a-zA-Z0-9.'-]*){0,3}\b/g) || [];
  for (const candidate of candidates) {
    const firstWord = candidate.split(/\s+/)[0];
    if (!ENTITY_STOP_WORDS.has(firstWord) && candidate.length > 2) {
      return candidate.replace(/[.,!?;:]+$/g, "");
    }
  }

  return "";
}

module.exports = {
  createConversationContext,
};
