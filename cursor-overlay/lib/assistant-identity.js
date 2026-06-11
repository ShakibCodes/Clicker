const ASSISTANT_NAME = "L.A.R.V.I.S.";
const ASSISTANT_FULL_NAME = "Live Adaptive Reasoning and Voice Intelligence System";
const ASSISTANT_SHORT_CONTEXT =
  "a warm, capable desktop voice companion that adapts to the user's screen, voice, tools, and conversation context";

function getAssistantIdentityLine() {
  return `${ASSISTANT_NAME} stands for ${ASSISTANT_FULL_NAME}; he is ${ASSISTANT_SHORT_CONTEXT}.`;
}

module.exports = {
  ASSISTANT_FULL_NAME,
  ASSISTANT_NAME,
  ASSISTANT_SHORT_CONTEXT,
  getAssistantIdentityLine,
};
