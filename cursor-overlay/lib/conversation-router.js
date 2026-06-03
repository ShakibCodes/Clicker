/* eslint-disable @typescript-eslint/no-require-imports */
const { extractBuddyChatIntent } = require("./buddy-chat");
const {
  extractBrowserTaskIntent,
  extractGenericOpenWebsiteIntent,
  extractMultipleBrowserTaskIntents,
} = require("./browser-commands");
const { extractCursorColorIntent } = require("./cursor-commands");
const { buildReply } = require("./reply-builder");
const { extractWebKnowledgeIntent } = require("./web-knowledge");

function createConversationRouter({
  actionExecutor,
  answerBuddyChat,
  answerWebKnowledgeQuestion,
  applyCursorColor,
  browserCommands,
  conversationContext,
  overlayWindowProvider,
  planAction,
  speakInterim,
}) {
  async function resolve(transcript, payload) {
    const overlayWindow = overlayWindowProvider();

    const cursorColorIntent = extractCursorColorIntent(transcript);
    if (cursorColorIntent) {
      return applyCursorColor(overlayWindow, cursorColorIntent);
    }

    const multipleBrowserTasks = extractMultipleBrowserTaskIntents(transcript);
    if (multipleBrowserTasks.length > 0) {
      return {
        message: browserCommands.openMultipleBrowserTasks(multipleBrowserTasks),
        route: "command",
      };
    }

    const directBrowserTask = extractBrowserTaskIntent(transcript);
    if (directBrowserTask) {
      return {
        message: await browserCommands.openBrowserTask(directBrowserTask),
        route: "command",
      };
    }

    const directGenericWebsite = extractGenericOpenWebsiteIntent(transcript);
    if (directGenericWebsite) {
      return {
        message: browserCommands.openGenericWebsite(directGenericWebsite),
        route: "command",
      };
    }

    const buddyChatIntent = extractBuddyChatIntent(transcript);
    if (buddyChatIntent) {
      return {
        message: await answerBuddyChat(buddyChatIntent),
        memoryType: "chat",
        route: "chat",
      };
    }

    const resolvedContext = conversationContext.resolveFollowUp(transcript);
    const webKnowledgeIntent = extractWebKnowledgeIntent(transcript, resolvedContext);
    if (webKnowledgeIntent) {
      await speakInterim(buildReply("webSearchStart"));
      overlayWindow?.webContents.send("assistant:status", {
        text: "Checking the web...",
      });
      const message = await answerWebKnowledgeQuestion(webKnowledgeIntent).catch(() => {
        return "I tried checking the web, but I could not get reliable results right now.";
      });
      return {
        message,
        memoryType: "web",
        resolvedContext,
        route: "web",
      };
    }

    const plan = await planAction(transcript, payload);
    if (String(plan?.action || "none") === "none") {
      return {
        message: await answerBuddyChat({ message: transcript }),
        memoryType: "chat",
        route: "chat",
      };
    }

    return {
      ...(await actionExecutor.executePlannedAction(plan)),
      route: "command",
    };
  }

  return {
    resolve,
  };
}

module.exports = {
  createConversationRouter,
};
