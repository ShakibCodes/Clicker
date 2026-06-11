/* eslint-disable @typescript-eslint/no-require-imports */
const { URLSearchParams } = require("url");
const { getGroqTextApiKey } = require("./env");
const { GROQ_MODELS } = require("./groq-models");
const { buildReply } = require("./reply-builder");
const { sanitizeAssistantText } = require("./response-sanitizer");
const { detectResponseLanguage, getLanguageInstruction, normalizeTranscript } = require("./text-utils");

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];
const MAX_CONTEXT_MESSAGES = 8;

function createGmailIntegration({ googleAccount }) {
  let lastEmailContext = null;

  function getStatus() {
    const googleStatus = googleAccount.getStatus();
    return {
      connected: Boolean(googleStatus.services?.gmail?.connected),
      email: googleStatus.email || "",
      scopes: GMAIL_SCOPES,
    };
  }

  async function connect() {
    return googleAccount.enableService("gmail");
  }

  function disconnect() {
    lastEmailContext = null;
    return googleAccount.disableService("gmail");
  }

  async function answer(intent) {
    const language = intent.responseLanguage || "english";
    const status = getStatus();
    if (!status.connected) {
      if (intent.type === "connect") {
        const connected = await connect();
        return {
          message: connected.message,
          route: "gmail",
        };
      }

      return {
        message: buildGmailReply("notConnected", language),
        route: "gmail",
      };
    }

    if (intent.type === "connect") {
      return {
        message: status.email ? `Gmail is already connected as ${status.email}.` : "Gmail is already connected.",
        route: "gmail",
      };
    }

    if (intent.type === "status") {
      return {
        message: status.email ? `Gmail is connected as ${status.email}.` : "Gmail is connected.",
        route: "gmail",
      };
    }

    if (intent.type === "recent") {
      const messages = await getRecentMessages({ fromYesterday: intent.fromYesterday });
      lastEmailContext = buildEmailContext(messages);
      return {
        message: await summarizeEmails(intent.query, messages, language, "recent"),
        memoryType: "gmail",
        route: "gmail",
      };
    }

    if (intent.type === "important") {
      const messages = await getImportantMessages();
      lastEmailContext = buildEmailContext(messages);
      return {
        message: await summarizeEmails(intent.query, messages, language, "important"),
        memoryType: "gmail",
        route: "gmail",
      };
    }

    if (intent.type === "replies") {
      const messages = await getRepliesToMe();
      lastEmailContext = buildEmailContext(messages);
      return {
        message: await summarizeEmails(intent.query, messages, language, "replies"),
        memoryType: "gmail",
        route: "gmail",
      };
    }

    if (intent.type === "draftReply") {
      const targetMessage = selectTargetMessage(intent);
      if (!targetMessage) {
        return {
          message: buildGmailReply("noReplyTarget", language),
          route: "gmail",
        };
      }

      const draft = await createReplyDraft(targetMessage, intent.query, language);
      return {
        message: draft.ok
          ? buildGmailReply("drafted", language, { target: targetMessage.fromName || targetMessage.fromEmail || "them" })
          : draft.message,
        memoryType: "gmail",
        route: "gmail",
      };
    }

    return {
      message: buildGmailReply("unsupported", language),
      route: "gmail",
    };
  }

  async function getRecentMessages(options = {}) {
    const query = options.fromYesterday ? `after:${formatGmailDate(getYesterday())}` : "newer_than:2d";
    return listDetailedMessages(query, 10);
  }

  async function getImportantMessages() {
    const messages = await listDetailedMessages("newer_than:14d", 15);
    return messages.filter(isImportantMessage).slice(0, 8);
  }

  async function getRepliesToMe() {
    const profile = await getProfile();
    const messages = await listDetailedMessages("newer_than:30d -from:me", 12);
    const replyMessages = [];

    for (const message of messages) {
      const thread = await gmailFetch(`/gmail/v1/users/me/threads/${message.threadId}?format=metadata&metadataHeaders=From&metadataHeaders=Date&metadataHeaders=Subject`);
      const threadMessages = Array.isArray(thread?.messages) ? thread.messages.map(parseGmailMessage) : [];
      const latestFromMe = isFromUser(message.fromEmail, profile.emailAddress);
      const hasEarlierMine = threadMessages.some((threadMessage) => {
        return threadMessage.internalDate < message.internalDate && isFromUser(threadMessage.fromEmail, profile.emailAddress);
      });

      if (!latestFromMe && hasEarlierMine) {
        replyMessages.push(message);
      }
    }

    return replyMessages.slice(0, 8);
  }

  async function listDetailedMessages(query, maxResults) {
    const params = new URLSearchParams({
      maxResults: String(maxResults),
      q: query,
    });
    const listed = await gmailFetch(`/gmail/v1/users/me/messages?${params.toString()}`);
    const messageRefs = Array.isArray(listed?.messages) ? listed.messages : [];
    const detailed = await Promise.all(
      messageRefs.slice(0, maxResults).map((message) => {
        return gmailFetch(
          `/gmail/v1/users/me/messages/${message.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To`,
        ).then(parseGmailMessage);
      }),
    );

    return detailed.filter(Boolean);
  }

  async function createReplyDraft(message, userInstruction, language) {
    const replyText = await generateReplyText(message, userInstruction, language);
    const raw = buildReplyMime(message, replyText);
    const body = {
      message: {
        raw,
        threadId: message.threadId,
      },
    };

    await gmailFetch("/gmail/v1/users/me/drafts", {
      body,
      method: "POST",
    });

    return { ok: true };
  }

  async function generateReplyText(message, userInstruction, language) {
    const apiKey = getGroqTextApiKey();
    const fallback = buildFallbackReplyText(message, language);
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
          temperature: 0.55,
          messages: [
            {
              role: "system",
              content: `Write a short email reply from the user's side. ${getLanguageInstruction(language)} Output only the email body. Do not include subject, labels, analysis, or quoted original email.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                instruction: userInstruction,
                originalEmail: {
                  from: message.from,
                  subject: message.subject,
                  snippet: message.snippet,
                },
              }),
            },
          ],
        }),
      });

      if (!response.ok) {
        return fallback;
      }

      const data = await response.json();
      return sanitizeAssistantText(data.choices?.[0]?.message?.content, fallback).slice(0, 1200) || fallback;
    } catch {
      return fallback;
    }
  }

  async function summarizeEmails(question, messages, language, mode) {
    if (messages.length === 0) {
      return buildGmailReply(mode === "important" ? "noImportant" : "noMessages", language);
    }

    const apiKey = getGroqTextApiKey();
    if (!apiKey) {
      return summarizeEmailsFallback(messages, language);
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
          temperature: 0.25,
          messages: [
            {
              role: "system",
              content: `You summarize the user's Gmail results. ${getLanguageInstruction(language)} Be concise and practical. Mention sender names and subjects when useful. Do not reveal raw headers. If asked about important emails, prioritize urgent/important-looking messages.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                question,
                messages: messages.slice(0, MAX_CONTEXT_MESSAGES).map(toSummarizableMessage),
              }),
            },
          ],
        }),
      });

      if (!response.ok) {
        return summarizeEmailsFallback(messages, language);
      }

      const data = await response.json();
      return sanitizeAssistantText(data.choices?.[0]?.message?.content, summarizeEmailsFallback(messages, language)).slice(0, 450);
    } catch {
      return summarizeEmailsFallback(messages, language);
    }
  }

  function selectTargetMessage(intent) {
    const messages = lastEmailContext?.messages || [];
    if (messages.length === 0) {
      return null;
    }

    const normalized = normalizeTranscript(intent.query);
    const senderMatch = messages.find((message) => {
      const sender = normalizeTranscript(`${message.fromName} ${message.fromEmail}`);
      return sender && normalized.includes(sender.split(/\s+/)[0]);
    });

    return senderMatch || messages[0];
  }

  async function getProfile() {
    const profile = await gmailFetch("/gmail/v1/users/me/profile");
    return profile || {};
  }

  async function gmailFetch(endpoint, options = {}) {
    return googleAccount.fetchJson("gmail", "https://gmail.googleapis.com", endpoint, options);
  }

  return {
    answer,
    connect,
    disconnect,
    getStatus,
  };
}

function extractGmailIntent(transcript) {
  const responseLanguage = detectResponseLanguage(transcript);
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\p{L}\p{M}\p{N}\s?.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  const mentionsGmail = /\b(gmail|gamil|email|emails|mail|inbox)\b/.test(normalized);
  const connectIntent = /\b(connect|enable|setup|set up|link)\b/.test(normalized) && /\b(gmail|google mail)\b/.test(normalized);
  if (connectIntent) {
    return { query: transcript, responseLanguage, type: "connect" };
  }

  if (!mentionsGmail && !/\b(write|draft|send|reply|replied|response|respond)\b/.test(normalized)) {
    return null;
  }

  if (/\b(status|connected)\b/.test(normalized) && /\b(gmail|email)\b/.test(normalized)) {
    return { query: transcript, responseLanguage, type: "status" };
  }

  const writeReplyIntent =
    /\b(write|draft|reply|respond|send)\b/.test(normalized) &&
    /\b(reply|response|email|something|short|good|nice)\b/.test(normalized) &&
    /\b(from my side|for me|to him|to her|to them|him|her|them)\b/.test(normalized);
  if (writeReplyIntent) {
    return { query: transcript, responseLanguage, type: "draftReply" };
  }

  const repliesToMeIntent =
    /\b(reply|replies|replied|response|responded)\b/.test(normalized) &&
    (/\b(to my email|to me|i got|received|from yesterday|mine|my email|i have gave first|i gave first)\b/.test(normalized) ||
      /\b(any|is there)\b/.test(normalized));
  if (repliesToMeIntent) {
    return { query: transcript, responseLanguage, type: "replies" };
  }

  if (/\b(important|urgent|priority|serious)\b/.test(normalized)) {
    return { query: transcript, responseLanguage, type: "important" };
  }

  if (/\b(new|latest|recent|received|recieved|got|yesterday|today|now|message|messages|mail|email|emails)\b/.test(normalized)) {
    return {
      fromYesterday: /\byesterday\b/.test(normalized),
      query: transcript,
      responseLanguage,
      type: "recent",
    };
  }

  return null;
}

function parseGmailMessage(message) {
  const headers = message?.payload?.headers || [];
  const getHeader = (name) => headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || "";
  const from = getHeader("From");
  const fromParts = parseEmailAddress(from);

  return {
    date: getHeader("Date"),
    from,
    fromEmail: fromParts.email,
    fromName: fromParts.name,
    id: message.id,
    inReplyTo: getHeader("In-Reply-To"),
    internalDate: Number(message.internalDate || 0),
    messageId: getHeader("Message-ID"),
    references: getHeader("References"),
    snippet: message.snippet || "",
    subject: getHeader("Subject") || "(no subject)",
    threadId: message.threadId,
  };
}

function parseEmailAddress(value) {
  const clean = String(value || "").trim();
  const match = clean.match(/^(.*?)<([^>]+)>$/);
  if (!match) {
    return {
      email: clean,
      name: clean.split("@")[0] || clean,
    };
  }

  return {
    email: match[2].trim(),
    name: match[1].trim().replace(/^"|"$/g, "") || match[2].split("@")[0],
  };
}

function buildEmailContext(messages) {
  return {
    messages: messages.slice(0, MAX_CONTEXT_MESSAGES),
    savedAt: Date.now(),
  };
}

function isImportantMessage(message) {
  const text = normalizeTranscript(`${message.subject} ${message.snippet}`);
  return /\b(urgent|important|asap|deadline|action required|invoice|payment|interview|offer|security|verify)\b/.test(text);
}

function isFromUser(fromEmail, userEmail) {
  return normalizeTranscript(fromEmail) === normalizeTranscript(userEmail);
}

function toSummarizableMessage(message) {
  return {
    date: message.date,
    from: message.fromName || message.fromEmail,
    snippet: message.snippet,
    subject: message.subject,
  };
}

function summarizeEmailsFallback(messages, language) {
  const count = messages.length;
  const previews = messages
    .slice(0, 3)
    .map((message) => `${message.fromName || message.fromEmail}: ${message.subject}`)
    .join("; ");

  if (language === "hinglish") {
    return `Mujhe ${count} relevant email${count === 1 ? "" : "s"} mili. Top ones: ${previews}.`;
  }
  if (language === "hindi") {
    return `मुझे ${count} relevant email मिली. Top ones: ${previews}.`;
  }
  if (language === "urdu") {
    return `مجھے ${count} relevant email ملی. Top ones: ${previews}.`;
  }
  return `I found ${count} relevant email${count === 1 ? "" : "s"}. Top ones: ${previews}.`;
}

function buildGmailReply(type, language, values = {}) {
  const target = values.target || "them";
  const replies = {
    english: {
      drafted: `Done — I drafted a short reply to ${target}.`,
      noImportant: "I did not find anything that looks clearly important right now.",
      noMessages: "I did not find any matching emails right now.",
      noReplyTarget: "I need an email context first. Ask me about recent or important emails, then I can draft a reply.",
      notConnected: "Gmail is not enabled yet. Open Integrations, connect Google, then enable Gmail.",
      unsupported: "I can check Gmail, but I do not understand that email request yet.",
    },
    hindi: {
      drafted: `हो गया — मैंने ${target} के लिए short reply draft कर दिया.`,
      noImportant: "मुझे अभी कोई clearly important email नहीं मिली.",
      noMessages: "मुझे अभी matching emails नहीं मिलीं.",
      noReplyTarget: "पहले email context चाहिए. Recent या important emails पूछो, फिर मैं reply draft कर दूँगी.",
      notConnected: "Gmail अभी connected नहीं है. Integrations में जाकर Gmail connect करो.",
      unsupported: "मैं Gmail check कर सकती हूँ, पर ये email request अभी समझ नहीं आई.",
    },
    urdu: {
      drafted: `ہو گیا — میں نے ${target} کے لیے short reply draft کر دیا.`,
      noImportant: "مجھے ابھی کوئی clearly important email نہیں ملی.",
      noMessages: "مجھے ابھی matching emails نہیں ملیں.",
      noReplyTarget: "پہلے email context چاہیے. Recent یا important emails پوچھیں، پھر میں reply draft کر دوں گی.",
      notConnected: "Gmail ابھی connected نہیں ہے. Integrations میں جا کر Gmail connect کریں.",
      unsupported: "میں Gmail check کر سکتی ہوں، مگر یہ email request ابھی سمجھ نہیں آئی.",
    },
    hinglish: {
      drafted: `Done — maine ${target} ke liye short reply draft kar diya.`,
      noImportant: "Abhi mujhe koi clearly important email nahi mili.",
      noMessages: "Abhi mujhe matching emails nahi mili.",
      noReplyTarget: "Pehle email context chahiye. Recent ya important emails pucho, phir main reply draft kar dungi.",
      notConnected: "Gmail abhi enabled nahi hai. Integrations mein Google connect karke Gmail enable karo.",
      unsupported: "Main Gmail check kar sakti hoon, but ye email request abhi clear nahi hai.",
    },
  };
  return replies[language]?.[type] || replies.english[type] || buildReply("unsupported", {}, language);
}

function buildFallbackReplyText(message, language) {
  const name = message.fromName || "there";
  if (language === "hindi") {
    return `Hi ${name},\n\nआपके message के लिए thanks. यह सुनकर अच्छा लगा.\n\nBest,`;
  }
  if (language === "urdu") {
    return `Hi ${name},\n\nآپ کے message کے لیے thanks. یہ سن کر اچھا لگا.\n\nBest,`;
  }
  if (language === "hinglish") {
    return `Hi ${name},\n\nThanks for your message. Ye sunke achha laga.\n\nBest,`;
  }
  return `Hi ${name},\n\nThanks for your message. I appreciate it.\n\nBest,`;
}

function buildReplyMime(message, replyText) {
  const to = message.fromEmail || message.from;
  const subject = /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`;
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeMimeHeader(subject)}`,
    "Content-Type: text/plain; charset=UTF-8",
  ];
  if (message.messageId) {
    headers.push(`In-Reply-To: ${message.messageId}`);
  }
  if (message.references || message.messageId) {
    headers.push(`References: ${[message.references, message.messageId].filter(Boolean).join(" ")}`);
  }

  return base64UrlEncode(`${headers.join("\r\n")}\r\n\r\n${replyText}`);
}

function encodeMimeHeader(value) {
  return /[^\x20-\x7E]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=` : value;
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getYesterday() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date;
}

function formatGmailDate(date) {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

module.exports = {
  _test: {
    base64UrlEncode,
    buildReplyMime,
    extractGmailIntent,
    parseEmailAddress,
    parseGmailMessage,
  },
  createGmailIntegration,
  extractGmailIntent,
};
