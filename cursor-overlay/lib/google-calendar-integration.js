/* eslint-disable @typescript-eslint/no-require-imports */
const { URLSearchParams } = require("url");
const { getGroqTextApiKey } = require("./env");
const { GROQ_MODELS } = require("./groq-models");
const { buildReply } = require("./reply-builder");
const { sanitizeAssistantText } = require("./response-sanitizer");
const { detectResponseLanguage, getLanguageInstruction, normalizeTranscript } = require("./text-utils");

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
const MAX_CONTEXT_EVENTS = 10;
const WORKDAY_START_HOUR = 9;
const WORKDAY_END_HOUR = 18;

function createGoogleCalendarIntegration({ googleAccount }) {
  function getStatus() {
    const googleStatus = googleAccount.getStatus();
    return {
      connected: Boolean(googleStatus.services?.calendar?.connected),
      email: googleStatus.email || "",
      scopes: CALENDAR_SCOPES,
    };
  }

  async function connect() {
    return googleAccount.enableService("calendar");
  }

  function disconnect() {
    return googleAccount.disableService("calendar");
  }

  async function answer(intent) {
    const language = intent.responseLanguage || "english";
    const status = getStatus();
    if (!status.connected) {
      if (intent.type === "connect") {
        const connected = await connect();
        return {
          message: connected.message,
          route: "calendar",
        };
      }

      return {
        message: buildCalendarReply("notConnected", language),
        route: "calendar",
      };
    }

    if (intent.type === "connect") {
      return {
        message: status.email ? `Google Calendar is already connected as ${status.email}.` : "Google Calendar is already connected.",
        route: "calendar",
      };
    }

    if (intent.type === "status") {
      return {
        message: status.email ? `Google Calendar is connected as ${status.email}.` : "Google Calendar is connected.",
        route: "calendar",
      };
    }

    if (intent.type === "free") {
      const range = getIntentDateRange(intent);
      const events = await listEvents(range);
      return {
        message: summarizeFreeSlots(events, range, language),
        memoryType: "calendar",
        route: "calendar",
      };
    }

    const range = getIntentDateRange(intent);
    const events = await listEvents(range);
    return {
      message: await summarizeCalendarEvents(intent.query, events, range, language),
      memoryType: "calendar",
      route: "calendar",
    };
  }

  async function listEvents(range) {
    const params = new URLSearchParams({
      maxResults: String(MAX_CONTEXT_EVENTS),
      orderBy: "startTime",
      singleEvents: "true",
      timeMax: range.end.toISOString(),
      timeMin: range.start.toISOString(),
    });
    const data = await calendarFetch(`/calendar/v3/calendars/primary/events?${params.toString()}`);
    const events = Array.isArray(data?.items) ? data.items : [];
    return events.map(parseCalendarEvent).filter(Boolean);
  }

  async function summarizeCalendarEvents(question, events, range, language) {
    if (events.length === 0) {
      return buildCalendarReply("noEvents", language, { label: range.label });
    }

    const apiKey = getGroqTextApiKey();
    const fallback = summarizeCalendarEventsFallback(events, range, language);
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
          temperature: 0.25,
          messages: [
            {
              role: "system",
              content: `You summarize Google Calendar events for the user. ${getLanguageInstruction(language)} Be concise, practical, and spoken-friendly. Mention event titles, times, and meeting links only when useful.`,
            },
            {
              role: "user",
              content: JSON.stringify({
                dateRange: {
                  end: range.end.toISOString(),
                  label: range.label,
                  start: range.start.toISOString(),
                },
                events: events.slice(0, MAX_CONTEXT_EVENTS),
                question,
              }),
            },
          ],
        }),
      });

      if (!response.ok) {
        return fallback;
      }

      const data = await response.json();
      return sanitizeAssistantText(data.choices?.[0]?.message?.content, fallback).slice(0, 450);
    } catch {
      return fallback;
    }
  }

  async function calendarFetch(endpoint, options = {}) {
    return googleAccount.fetchJson("calendar", "https://www.googleapis.com", endpoint, options);
  }

  return {
    answer,
    connect,
    disconnect,
    getStatus,
  };
}

function extractGoogleCalendarIntent(transcript) {
  const responseLanguage = detectResponseLanguage(transcript);
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\p{L}\p{M}\p{N}\s?.'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return null;
  }

  const mentionsCalendar = /\b(calendar|calender|google calendar|schedule|meetings|meeting|events|appointment|appointments)\b/.test(normalized);
  const connectIntent =
    /\b(connect|enable|setup|set up|link)\b/.test(normalized) && /\b(calendar|calender|google calendar)\b/.test(normalized);
  if (connectIntent) {
    return { query: transcript, responseLanguage, type: "connect" };
  }

  if (!mentionsCalendar) {
    const implicitAvailabilityIntent =
      /\b(free|available|availability|busy)\b/.test(normalized) && /\b(today|tomorrow|tmrw|week|schedule)\b/.test(normalized);
    if (!implicitAvailabilityIntent) {
      return null;
    }
  }

  if (/\b(status|connected)\b/.test(normalized) && /\b(calendar|calender)\b/.test(normalized)) {
    return { query: transcript, responseLanguage, type: "status" };
  }

  if (/\b(free|available|availability|open slot|open slots|gap|gaps|busy)\b/.test(normalized)) {
    return {
      query: transcript,
      rangeType: extractRangeType(normalized),
      responseLanguage,
      type: "free",
    };
  }

  if (/\b(today|tomorrow|tmrw|upcoming|next|week|schedule|agenda|meeting|meetings|event|events|appointment|appointments)\b/.test(normalized)) {
    return {
      query: transcript,
      rangeType: extractRangeType(normalized),
      responseLanguage,
      type: "events",
    };
  }

  return null;
}

function extractRangeType(normalized) {
  if (/\b(tomorrow|tmrw)\b/.test(normalized)) {
    return "tomorrow";
  }
  if (/\b(next week|week)\b/.test(normalized)) {
    return "week";
  }
  if (/\b(today|tonight|now)\b/.test(normalized)) {
    return "today";
  }
  return "upcoming";
}

function getIntentDateRange(intent) {
  const rangeType = intent.rangeType || "upcoming";
  const now = new Date();

  if (rangeType === "today") {
    return {
      end: endOfDay(now),
      label: "today",
      start: now,
    };
  }

  if (rangeType === "tomorrow") {
    const tomorrow = addDays(now, 1);
    return {
      end: endOfDay(tomorrow),
      label: "tomorrow",
      start: startOfDay(tomorrow),
    };
  }

  if (rangeType === "week") {
    return {
      end: addDays(now, 7),
      label: "the next week",
      start: now,
    };
  }

  return {
    end: addDays(now, 7),
    label: "the next 7 days",
    start: now,
  };
}

function parseCalendarEvent(event) {
  const startValue = event?.start?.dateTime || event?.start?.date || "";
  const endValue = event?.end?.dateTime || event?.end?.date || "";
  if (!startValue) {
    return null;
  }

  return {
    allDay: Boolean(event?.start?.date),
    description: stripHtml(event?.description || "").slice(0, 280),
    end: endValue,
    htmlLink: event?.htmlLink || "",
    location: event?.location || "",
    start: startValue,
    summary: event?.summary || "(no title)",
  };
}

function summarizeCalendarEventsFallback(events, range, language) {
  const previews = events
    .slice(0, 4)
    .map((event) => `${formatEventTime(event)} ${event.summary}`.trim())
    .join("; ");

  if (language === "hinglish") {
    return `${range.label} ke liye ${events.length} calendar event${events.length === 1 ? "" : "s"} hain: ${previews}.`;
  }
  return `You have ${events.length} calendar event${events.length === 1 ? "" : "s"} for ${range.label}: ${previews}.`;
}

function summarizeFreeSlots(events, range, language) {
  const slots = getFreeSlots(events, range);
  if (slots.length === 0) {
    return buildCalendarReply("noFreeSlots", language, { label: range.label });
  }

  const preview = slots
    .slice(0, 4)
    .map((slot) => `${formatClock(slot.start)} to ${formatClock(slot.end)}`)
    .join(", ");

  if (language === "hinglish") {
    return `${range.label} mein free slots: ${preview}.`;
  }
  return `Your free slots for ${range.label}: ${preview}.`;
}

function getFreeSlots(events, range) {
  const workStart = new Date(range.start);
  workStart.setHours(WORKDAY_START_HOUR, 0, 0, 0);
  const workEnd = new Date(range.start);
  workEnd.setHours(WORKDAY_END_HOUR, 0, 0, 0);
  const start = range.start > workStart ? range.start : workStart;
  const end = range.end < workEnd ? range.end : workEnd;

  if (start >= end) {
    return [];
  }

  const busy = events
    .filter((event) => !event.allDay)
    .map((event) => ({
      end: new Date(event.end),
      start: new Date(event.start),
    }))
    .filter((slot) => slot.end > start && slot.start < end)
    .sort((first, second) => first.start - second.start);

  const free = [];
  let cursor = start;
  for (const slot of busy) {
    if (slot.start > cursor) {
      free.push({ end: slot.start < end ? slot.start : end, start: cursor });
    }
    if (slot.end > cursor) {
      cursor = slot.end;
    }
  }
  if (cursor < end) {
    free.push({ end, start: cursor });
  }

  return free.filter((slot) => slot.end - slot.start >= 20 * 60 * 1000);
}

function buildCalendarReply(type, language, values = {}) {
  const label = values.label || "that time";
  const replies = {
    english: {
      noEvents: `You do not have any calendar events for ${label}.`,
      noFreeSlots: `I do not see a clear free slot for ${label}.`,
      notConnected: "Google Calendar is not enabled yet. Open Integrations, connect Google, then enable Calendar.",
      unsupported: "I can check Google Calendar, but I do not understand that schedule request yet.",
    },
    hinglish: {
      noEvents: `${label} ke liye calendar mein koi event nahi hai.`,
      noFreeSlots: `${label} ke liye clear free slot nahi dikh raha.`,
      notConnected: "Google Calendar abhi enabled nahi hai. Integrations mein Google connect karke Calendar enable karo.",
      unsupported: "Main Google Calendar check kar sakti hoon, but ye schedule request abhi clear nahi hai.",
    },
  };

  return replies[language]?.[type] || replies.english[type] || buildReply("unsupported", {}, language);
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatEventTime(event) {
  if (event.allDay) {
    return "All day";
  }

  const start = new Date(event.start);
  const end = new Date(event.end);
  if (Number.isNaN(start.getTime())) {
    return "";
  }
  if (Number.isNaN(end.getTime())) {
    return formatClock(start);
  }
  return `${formatClock(start)}-${formatClock(end)}`;
}

function formatClock(date) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

module.exports = {
  _test: {
    extractGoogleCalendarIntent,
    getFreeSlots,
    parseCalendarEvent,
  },
  createGoogleCalendarIntegration,
  extractGoogleCalendarIntent,
};
