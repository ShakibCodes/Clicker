function sanitizeAssistantText(input, fallback = "") {
  let text = String(input || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/\b(?:analysis|reasoning|thought process)\s*:\s*[\s\S]*?(?:final|answer)\s*:\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = stripReasoningLeadIn(text);
  text = stripQuotedUserLeadIn(text);
  text = text.replace(/\s+/g, " ").trim();

  return text || fallback;
}

function stripReasoningLeadIn(text) {
  const patterns = [
    /^the user (?:is saying|said|says|asked|is asking|wants|seems to want)[\s\S]{0,220}?(?:so|therefore|i should|i can|i will|i'll)\s+/i,
    /^i should [\s\S]{0,120}?\.\s*/i,
    /^i can [\s\S]{0,120}?\.\s*/i,
    /^i will [\s\S]{0,120}?\.\s*/i,
    /^we need to [\s\S]{0,180}?(?:so|therefore)\s+/i,
    /^i need to [\s\S]{0,180}?(?:so|therefore)\s+/i,
    /^to answer (?:that|this)[\s\S]{0,180}?(?:i should|i can|i will|i'll)\s+/i,
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, "");
  }

  return text;
}

function stripQuotedUserLeadIn(text) {
  return text.replace(/^["']?[^"']{0,160}["']?\s*(?:so|therefore)\s+/i, "");
}

module.exports = {
  sanitizeAssistantText,
};
