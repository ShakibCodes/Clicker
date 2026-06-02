/* eslint-disable @typescript-eslint/no-require-imports */
const { escapeRegExp, normalizeTranscript } = require("./text-utils");
const { buildReply, formatList } = require("./reply-builder");

const BROWSER_SITE_RULES = [
  {
    key: "gmail",
    displayName: "Gmail",
    aliases: ["gmail", "gamil", "google mail", "mail"],
    homeUrl: "https://mail.google.com",
    searchUrl: null,
  },
  {
    key: "google_calendar",
    displayName: "Google Calendar",
    aliases: ["google calendar", "google calender", "calendar", "calender"],
    homeUrl: "https://calendar.google.com",
    searchUrl: null,
  },
  {
    key: "google_drive",
    displayName: "Google Drive",
    aliases: ["google drive", "drive"],
    homeUrl: "https://drive.google.com",
    searchUrl: null,
  },
  {
    key: "google_docs",
    displayName: "Google Docs",
    aliases: ["google docs", "docs"],
    homeUrl: "https://docs.google.com",
    searchUrl: null,
  },
  {
    key: "google_sheets",
    displayName: "Google Sheets",
    aliases: ["google sheets", "sheets"],
    homeUrl: "https://sheets.google.com",
    searchUrl: null,
  },
  {
    key: "google_slides",
    displayName: "Google Slides",
    aliases: ["google slides", "slides"],
    homeUrl: "https://slides.google.com",
    searchUrl: null,
  },
  {
    key: "google_meet",
    displayName: "Google Meet",
    aliases: ["google meet", "meet"],
    homeUrl: "https://meet.google.com",
    searchUrl: null,
  },
  {
    key: "google_maps",
    displayName: "Google Maps",
    aliases: ["google maps", "maps"],
    homeUrl: "https://maps.google.com",
    searchUrl: (query) => `https://www.google.com/maps/search/${encodeURIComponent(query)}`,
  },
  {
    key: "youtube",
    displayName: "YouTube",
    aliases: ["youtube", "yt"],
    homeUrl: "https://www.youtube.com",
    searchUrl: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
  },
  {
    key: "google",
    displayName: "Google",
    aliases: ["google"],
    homeUrl: "https://www.google.com",
    searchUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    key: "github",
    displayName: "GitHub",
    aliases: ["github"],
    homeUrl: "https://github.com",
    searchUrl: (query) => `https://github.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    key: "amazon",
    displayName: "Amazon",
    aliases: ["amazon"],
    homeUrl: "https://www.amazon.in",
    searchUrl: (query) => `https://www.amazon.in/s?k=${encodeURIComponent(query)}`,
  },
  {
    key: "flipkart",
    displayName: "Flipkart",
    aliases: ["flipkart"],
    homeUrl: "https://www.flipkart.com",
    searchUrl: (query) => `https://www.flipkart.com/search?q=${encodeURIComponent(query)}`,
  },
  {
    key: "wikipedia",
    displayName: "Wikipedia",
    aliases: ["wikipedia", "wiki"],
    homeUrl: "https://www.wikipedia.org",
    searchUrl: (query) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
  },
  {
    key: "reddit",
    displayName: "Reddit",
    aliases: ["reddit"],
    homeUrl: "https://www.reddit.com",
    searchUrl: (query) => `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`,
  },
  {
    key: "linkedin",
    displayName: "LinkedIn",
    aliases: ["linkedin"],
    homeUrl: "https://www.linkedin.com",
    searchUrl: (query) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query)}`,
  },
  {
    key: "x",
    displayName: "X",
    aliases: ["x", "twitter"],
    homeUrl: "https://x.com",
    searchUrl: (query) => `https://x.com/search?q=${encodeURIComponent(query)}`,
  },
];

function extractBrowserTaskIntent(transcript) {
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return null;
  }

  let matchedRule = null;
  let matchedAlias = "";
  for (const rule of BROWSER_SITE_RULES) {
    const alias = rule.aliases.find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(normalized));
    if (alias) {
      matchedRule = rule;
      matchedAlias = alias;
      break;
    }
  }

  if (!matchedRule) {
    return null;
  }

  const hasTaskIntent = hasBrowserTaskIntent(normalized, matchedAlias);

  if (!hasTaskIntent) {
    return null;
  }

  let candidate = normalized;
  const escapedAlias = escapeRegExp(matchedAlias);
  candidate = candidate.replace(new RegExp(`\\b(on|in)\\s+${escapedAlias}\\b`, "g"), " ");
  candidate = candidate.replace(new RegExp(`\\b${escapedAlias}\\b`, "g"), " ");
  candidate = candidate.replace(/\b(open|go to|launch|start)\b/g, " ");
  candidate = candidate.replace(/\b(i want to|i wanna|i would like to|can you|please|for me)\b/g, " ");
  candidate = candidate.replace(/\b(search( for)?|play|listen( to)?|watch|buy|order|find|show|look up)\b/g, " ");
  candidate = candidate.replace(/\b(song|songs|music|videos?|about|for)\b/g, " ");
  candidate = candidate.replace(/\s+/g, " ").trim();

  const query = candidate.length >= 2 ? candidate : "";
  return {
    site: matchedRule.key,
    query,
    rule: matchedRule,
  };
}

function extractMultipleBrowserTaskIntents(transcript) {
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!hasOpenIntent(normalized)) {
    return [];
  }

  const matches = [];
  for (const rule of BROWSER_SITE_RULES) {
    const aliasMatch = findFirstAliasMatch(normalized, rule.aliases);
    if (aliasMatch) {
      matches.push({
        index: aliasMatch.index,
        site: rule.key,
        query: "",
        rule,
      });
    }
  }

  const genericWebsiteMatches = extractGenericOpenWebsiteIntents(transcript);
  for (const intent of genericWebsiteMatches) {
    matches.push({
      index: intent.index,
      genericWebsite: intent,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const match of matches.sort((left, right) => left.index - right.index)) {
    const key = match.rule?.key || match.genericWebsite?.url;
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(match);
  }

  return deduped.length >= 2 ? deduped : [];
}

function hasOpenIntent(normalized) {
  return (
    /\b(open|launch|start)\b/.test(normalized) ||
    /\bgo to\b/.test(normalized)
  );
}

function hasBrowserTaskIntent(normalized, matchedAlias) {
  const alias = escapeRegExp(matchedAlias);

  if (new RegExp(`\\b(open|launch|start)\\b.{0,24}\\b${alias}\\b`).test(normalized)) {
    return true;
  }

  if (new RegExp(`\\bgo to\\b.{0,24}\\b${alias}\\b`).test(normalized)) {
    return true;
  }

  if (new RegExp(`\\b(search|look up|find|show)\\b.{0,80}\\b(on|in|with|using)\\s+${alias}\\b`).test(normalized)) {
    return true;
  }

  if (new RegExp(`\\b(search|look up|find|show)\\b\\s+${alias}\\b`).test(normalized)) {
    return true;
  }

  if (new RegExp(`\\b(play|watch|listen to|buy|order)\\b.{0,80}\\b(on|in|from)\\s+${alias}\\b`).test(normalized)) {
    return true;
  }

  if (new RegExp(`\\b${alias}\\b\\s+(search|play|watch|find|show)\\b`).test(normalized)) {
    return true;
  }

  return false;
}

function findFirstAliasMatch(normalized, aliases) {
  let bestMatch = null;
  for (const alias of aliases) {
    const match = new RegExp(`\\b${escapeRegExp(alias)}\\b`).exec(normalized);
    if (!match) {
      continue;
    }
    if (!bestMatch || match.index < bestMatch.index) {
      bestMatch = {
        alias,
        index: match.index,
      };
    }
  }
  return bestMatch;
}

function extractGenericOpenWebsiteIntent(transcript) {
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/^(?:please\s+)?(?:open|go to|launch|start)\s+([a-z0-9][a-z0-9.-]+\.[a-z]{2,})(?:\s+for me)?$/);
  if (!match) {
    return null;
  }

  const hostname = match[1].replace(/^www\./, "");
  const url = `https://${hostname}`;
  const displayName = hostname
    .split(".")[0]
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  return { url, displayName };
}

function extractGenericOpenWebsiteIntents(transcript) {
  const normalized = normalizeTranscript(transcript)
    .replace(/[^\w\s.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!hasOpenIntent(normalized)) {
    return [];
  }

  const matches = [];
  const domainRegex = /\b([a-z0-9][a-z0-9.-]+\.[a-z]{2,})\b/g;
  let match = domainRegex.exec(normalized);
  while (match) {
    const hostname = match[1].replace(/^www\./, "");
    matches.push({
      index: match.index,
      url: `https://${hostname}`,
      displayName: hostname
        .split(".")[0]
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
    });
    match = domainRegex.exec(normalized);
  }

  return matches;
}

function createBrowserCommandRunner(shell) {
  async function openYouTubeTopResultOrSearch(query) {
    const cleanQuery = String(query || "").trim();
    if (!cleanQuery) {
      shell.openExternal("https://www.youtube.com");
      return buildReply("open", { target: "YouTube" });
    }

    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`YouTube search request failed (${response.status}).`);
      }

      const html = await response.text();
      const match = html.match(/\"videoId\":\"([a-zA-Z0-9_-]{11})\"/);
      if (!match || !match[1]) {
        shell.openExternal(searchUrl);
        return buildYouTubeReply(cleanQuery, { didAutoplay: false });
      }

      const videoId = match[1];
      shell.openExternal(`https://www.youtube.com/watch?v=${videoId}&autoplay=1`);
      return buildYouTubeReply(cleanQuery, { didAutoplay: true });
    } catch {
      shell.openExternal(`https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}`);
      return buildYouTubeReply(cleanQuery, { didAutoplay: false });
    }
  }

  async function openBrowserTask(intent) {
    const query = String(intent?.query || "").trim();
    const rule = intent?.rule;
    if (!rule || !rule.homeUrl) {
      return "I understood the browser task, but I could not map that site safely yet.";
    }

    const friendlySiteName = rule.displayName || (rule.key === "x" ? "X" : rule.key[0].toUpperCase() + rule.key.slice(1));
    const speakingQuery = query.slice(0, 120);

    if (rule.key === "youtube" && query) {
      return openYouTubeTopResultOrSearch(query);
    }

    const url = query && typeof rule.searchUrl === "function" ? rule.searchUrl(query) : rule.homeUrl;
    shell.openExternal(url);
    return query && typeof rule.searchUrl === "function"
      ? buildReply("search", { site: friendlySiteName, query: speakingQuery })
      : buildReply("open", { target: friendlySiteName });
  }

  function openGenericWebsite(intent) {
    shell.openExternal(intent.url);
    return buildReply("open", { target: intent.displayName });
  }

  function openMultipleBrowserTasks(intents) {
    const displayNames = [];

    for (const intent of intents) {
      if (intent.genericWebsite) {
        shell.openExternal(intent.genericWebsite.url);
        displayNames.push(intent.genericWebsite.displayName);
        continue;
      }

      const rule = intent.rule;
      if (!rule?.homeUrl) {
        continue;
      }
      shell.openExternal(rule.homeUrl);
      displayNames.push(rule.displayName || rule.key);
    }

    return buildReply("multiOpen", { targets: formatList(displayNames) });
  }

  return {
    openBrowserTask,
    openGenericWebsite,
    openMultipleBrowserTasks,
  };
}

function classifyYouTubeQuery(query) {
  const normalized = normalizeTranscript(query).replace(/[^\w\s]/g, " ");
  const hasAny = (words) => words.some((word) => new RegExp(`\\b${word}\\b`).test(normalized));

  if (hasAny(["tutorial", "how", "learn", "course", "lecture", "class", "explain", "education", "study"])) {
    return "educational";
  }
  if (hasAny(["podcast", "interview", "news", "documentary", "review", "analysis"])) {
    return "informational";
  }
  if (hasAny(["rock", "metal", "punk", "grunge"])) {
    return "rock";
  }
  if (hasAny(["pop", "dance", "edm", "disco"])) {
    return "pop";
  }
  if (hasAny(["hip hop", "hiphop", "rap", "trap"])) {
    return "hiphop";
  }
  if (hasAny(["jazz", "blues", "lofi", "lo-fi"])) {
    return "chill";
  }
  if (hasAny(["song", "music", "track", "playlist", "album", "remix", "ac dc", "acdc"])) {
    return "music";
  }
  return "general";
}

function buildYouTubeReply(query, options = {}) {
  const topic = String(query || "").trim().slice(0, 80);
  const didAutoplay = Boolean(options.didAutoplay);
  const kind = classifyYouTubeQuery(query);

  if (kind === "educational") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }
  if (kind === "informational") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }
  if (kind === "rock") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }
  if (kind === "pop") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }
  if (kind === "hiphop") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }
  if (kind === "chill") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }
  if (kind === "music") {
    return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
  }

  return didAutoplay ? buildReply("play", { topic }) : buildReply("find", { topic });
}

module.exports = {
  createBrowserCommandRunner,
  extractBrowserTaskIntent,
  extractGenericOpenWebsiteIntent,
  extractMultipleBrowserTaskIntents,
};
