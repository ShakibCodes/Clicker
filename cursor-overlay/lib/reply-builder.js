const REPLY_TEMPLATES = {
  open: [
    "Sure, opening {target}.",
    "Yep, opening {target}.",
    "On it, opening {target}.",
    "Got it, opening {target}.",
    "{target} is coming up.",
  ],
  multiOpen: [
    "Sure, opening {targets}.",
    "Yep, opening {targets}.",
    "On it, opening {targets}.",
    "Got it, pulling up {targets}.",
  ],
  search: [
    "Sure, looking up {query}.",
    "Yep, searching for {query}.",
    "On it, searching {site} for {query}.",
    "Got it, pulling up {query}.",
  ],
  play: [
    "Nice, playing {topic}.",
    "Yep, playing {topic}.",
    "On it, playing {topic}.",
    "Good pick, playing {topic}.",
  ],
  find: [
    "Sure, finding {topic}.",
    "Yep, pulling up {topic}.",
    "On it, finding {topic}.",
  ],
  guide: [
    "Sure, I will walk you through {target}.",
    "Yep, starting a quick walkthrough of {target}.",
    "On it, I will guide you through {target}.",
  ],
  locate: [
    "Sure, I will point out {target}.",
    "Yep, I will show you where {target} is.",
    "On it, I will point to {target}.",
  ],
  located: [
    "There it is, I pointed to {target}.",
    "Found it, I pointed to {target}.",
    "Yep, that is {target}.",
  ],
  cursorColor: [
    "Sure, switching the cursor to {color}.",
    "Yep, making it {color}.",
    "Got it, cursor is {color} now.",
    "On it, changing the cursor to {color}.",
  ],
  webSearchStart: [
    "Okay, give me a few seconds. I’ll check the web for that.",
    "Sure, let me look through the internet for a moment.",
    "On it. I’ll search the web and pull together what looks reliable.",
    "Got it. Give me a moment while I check current sources.",
  ],
  unsupported: [
    "I heard you, but I cannot do that one yet.",
    "I got that, but that command is not ready yet.",
    "I heard you. I just do not know how to handle that one yet.",
  ],
  notFound: [
    "I could not spot {target} clearly. Keep it visible and ask me again.",
    "I cannot see {target} clearly yet. Bring it into view and try again.",
  ],
};

function buildReply(type, values = {}) {
  const templates = REPLY_TEMPLATES[type] || REPLY_TEMPLATES.unsupported;
  const template = templates[Math.floor(Math.random() * templates.length)];
  return template.replace(/\{(\w+)\}/g, (_match, key) => cleanValue(values[key]));
}

function formatList(items) {
  const cleanItems = items.map(cleanValue).filter(Boolean);
  if (cleanItems.length <= 2) {
    return cleanItems.join(" and ");
  }

  return `${cleanItems.slice(0, -1).join(", ")} and ${cleanItems[cleanItems.length - 1]}`;
}

function cleanValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = {
  buildReply,
  formatList,
};
