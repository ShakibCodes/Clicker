/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("assert");
const { createConversationContext } = require("../lib/conversation-context");
const { createConversationRouter } = require("../lib/conversation-router");
const { createDecisionLog } = require("../lib/decision-log");
const {
  createBrowserCommandRunner,
  extractBrowserTaskIntent,
  extractMultipleBrowserTaskIntents,
} = require("../lib/browser-commands");
const { buildReply } = require("../lib/reply-builder");
const { detectResponseLanguage } = require("../lib/text-utils");
const { _test: gmailTest } = require("../lib/gmail-integration");
const { _test: googleAccountTest } = require("../lib/google-account-integration");
const { _test: calendarTest } = require("../lib/google-calendar-integration");
const { _test: cloudAiTest } = require("../lib/cloud-ai");
const { _test, extractWebKnowledgeIntent } = require("../lib/web-knowledge");

function createTestRouter() {
  const opened = [];
  const decisionLog = createDecisionLog();
  const conversationContext = createConversationContext();
  const browserCommands = {
    openBrowserTask: async (intent) => {
      opened.push(intent.site);
      return `Opening ${intent.rule.displayName}`;
    },
    openGenericWebsite: (intent) => {
      opened.push(intent.url);
      return `Opening ${intent.displayName}`;
    },
    openMultipleBrowserTasks: (intents) => {
      for (const intent of intents) {
        opened.push(intent.rule?.key || intent.genericWebsite?.url);
      }
      return "Opening them now.";
    },
  };

  const router = createConversationRouter({
    actionExecutor: {
      executePlannedAction: async () => ({ message: "Executed." }),
    },
    answerBuddyChat: async (intent) => `chat:${intent.message}`,
    answerWebKnowledgeQuestion: async (intent) => `web:${intent.resolvedQuery}`,
    applyCursorColor: (_overlayWindow, intent) => ({ message: `Cursor ${intent.color}`, route: "command" }),
    browserCommands,
    calendarIntegration: {
      answer: async (intent) => ({ message: `calendar:${intent.type}`, route: "calendar" }),
    },
    conversationContext,
    decisionLog,
    overlayWindowProvider: () => ({
      webContents: {
        send: () => {},
      },
    }),
    planAction: async () => ({ action: "none" }),
    speakInterim: async () => {},
  });

  return {
    conversationContext,
    decisionLog,
    opened,
    router,
  };
}

async function run() {
  assert.strictEqual(
    extractBrowserTaskIntent('Hey I am on x.com, can you say "hi" to X'),
    null,
    "casual X mention must not open X",
  );
  assert.strictEqual(
    extractBrowserTaskIntent('Hey I am on YouTube and I am live, can you say "hi" to my subscribers'),
    null,
    "casual YouTube live mention must not open YouTube",
  );
  assert.deepStrictEqual(
    extractMultipleBrowserTaskIntents("open youtube, linkedin, github and gmail").map((intent) => intent.rule.key),
    ["youtube", "linkedin", "github", "gmail"],
    "multi-open should extract all requested sites once",
  );
  assert.strictEqual(detectResponseLanguage("gmail kholo yaar"), "hinglish");
  assert.strictEqual(detectResponseLanguage("\u091c\u0940\u092e\u0947\u0932 \u0916\u094b\u0932\u094b"), "hindi");
  assert.strictEqual(detectResponseLanguage("\u062c\u06cc \u0645\u06cc\u0644 \u06a9\u06be\u0648\u0644\u0648"), "urdu");
  assert.strictEqual(extractBrowserTaskIntent("gmail kholo")?.responseLanguage, "hinglish");

  const openedUrls = [];
  const realBrowserCommands = createBrowserCommandRunner({
    openExternal: (url) => openedUrls.push(url),
  });
  const hinglishOpenMessage = await realBrowserCommands.openBrowserTask(extractBrowserTaskIntent("gmail kholo"));
  assert.strictEqual(openedUrls[0], "https://mail.google.com");
  assert.match(hinglishOpenMessage, /(khol|open|aa raha)/i);

  assert.match(buildReply("open", { target: "Gmail" }, "hindi"), /(\u0916\u094b\u0932|\u0906 \u0930\u0939\u093e)/);
  assert.match(buildReply("open", { target: "Gmail" }, "urdu"), /(\u06a9\u06be\u0648\u0644|\u0622 \u0631\u06c1\u0627)/);
  assert.match(buildReply("open", { target: "Gmail" }, "hinglish"), /(khol|open|aa raha)/i);

  const chatRouter = createTestRouter();
  const chatResult = await chatRouter.router.resolve('Hey I am on YouTube and I am live, can you say "hi" to my subscribers', {});
  assert.strictEqual(chatResult.route, "chat");
  assert.strictEqual(chatRouter.opened.length, 0);

  const commandRouter = createTestRouter();
  const commandResult = await commandRouter.router.resolve("open gmail and github", {});
  assert.strictEqual(commandResult.route, "command");
  assert.deepStrictEqual(commandRouter.opened, ["gmail", "github"]);

  const webRouter = createTestRouter();
  const webResult = await webRouter.router.resolve("who has the most subscribers on youtube?", {});
  assert.strictEqual(webResult.route, "web");
  assert.match(webResult.message, /^web:/);

  const context = createConversationContext();
  context.remember({
    answer: "MrBeast is generally listed as the biggest YouTube channel by subscribers.",
    type: "web",
    userText: "Who has the most subscribers on YouTube?",
  });
  const resolved = context.resolveFollowUp("Is he a billionaire?");
  assert.strictEqual(resolved.isFollowUp, true);
  assert.match(resolved.query, /MrBeast/);
  assert.ok(extractWebKnowledgeIntent("Is he a billionaire?", resolved), "pronoun follow-up should route to web");
  assert.strictEqual(extractWebKnowledgeIntent("mrbeast kaun hai")?.responseLanguage, "hinglish");
  assert.strictEqual(
    extractWebKnowledgeIntent(
      "\u092e\u093f\u0938\u094d\u091f\u0930\u092c\u0940\u0938\u094d\u091f \u0915\u094c\u0928 \u0939\u0948",
    )?.responseLanguage,
    "hindi",
  );
  assert.strictEqual(
    extractWebKnowledgeIntent("\u0645\u0633\u0679\u0631 \u0628\u06cc\u0633\u0679 \u06a9\u0648\u0646 \u06c1\u06d2")?.responseLanguage,
    "urdu",
  );

  const articleText = _test.extractReadableText(`
    <html><body><nav>menu</nav><article><h1>Title</h1><p>Reliable article text about MrBeast.</p></article></body></html>
  `);
  assert.strictEqual(articleText, "Title Reliable article text about MrBeast.");
  assert.strictEqual(_test.isLikelyReadableUrl("https://example.com/story"), true);
  assert.strictEqual(_test.isLikelyReadableUrl("https://example.com/file.pdf"), false);

  assert.ok(chatRouter.decisionLog.list().some((entry) => entry.route === "chat"));
  assert.ok(commandRouter.decisionLog.list().some((entry) => entry.route === "command"));
  assert.ok(webRouter.decisionLog.list().some((entry) => entry.route === "web"));

  assert.strictEqual(gmailTest.extractGmailIntent("connect gmail")?.type, "connect");
  assert.strictEqual(gmailTest.extractGmailIntent("what new email from yesterday till now have I received")?.type, "recent");
  assert.strictEqual(gmailTest.extractGmailIntent("is there any important email I have received")?.type, "important");
  assert.strictEqual(gmailTest.extractGmailIntent("did I get any reply to my email")?.type, "replies");
  assert.strictEqual(gmailTest.extractGmailIntent("write something good and short from my side to him")?.type, "draftReply");

  const parsedAddress = gmailTest.parseEmailAddress('"Alex Doe" <alex@example.com>');
  assert.deepStrictEqual(parsedAddress, { email: "alex@example.com", name: "Alex Doe" });
  const rawReply = gmailTest.buildReplyMime(
    {
      from: '"Alex Doe" <alex@example.com>',
      fromEmail: "alex@example.com",
      messageId: "<message-1@example.com>",
      references: "<root@example.com>",
      subject: "Congrats",
      threadId: "thread-1",
    },
    "Thanks a lot. I really appreciate it.",
  );
  assert.match(rawReply, /^[A-Za-z0-9_-]+$/);

  assert.strictEqual(calendarTest.extractGoogleCalendarIntent("connect google calendar")?.type, "connect");
  assert.strictEqual(calendarTest.extractGoogleCalendarIntent("what meetings do I have today")?.type, "events");
  assert.strictEqual(calendarTest.extractGoogleCalendarIntent("am I free tomorrow")?.type, "free");
  assert.strictEqual(calendarTest.extractGoogleCalendarIntent("calendar status")?.type, "status");
  assert.strictEqual(calendarTest.parseCalendarEvent({ start: { dateTime: "2026-06-06T10:00:00+05:30" }, summary: "Standup" }).summary, "Standup");

  const calendarRouter = createTestRouter();
  const calendarResult = await calendarRouter.router.resolve("what meetings do I have today", {});
  assert.strictEqual(calendarResult.route, "calendar");
  assert.match(calendarResult.message, /^calendar:/);

  assert.deepStrictEqual(googleAccountTest.parseScopeString("scope-a  scope-b"), ["scope-a", "scope-b"]);
  assert.deepStrictEqual(googleAccountTest.mergeScopes(["scope-a"], ["scope-b", "scope-a"]), ["scope-a", "scope-b"]);
  assert.strictEqual(googleAccountTest.hasScopes(["scope-a", "scope-b"], ["scope-b"]), true);
  assert.strictEqual(googleAccountTest.hasScopes(["scope-a"], ["scope-b"]), false);

  assert.strictEqual(cloudAiTest.shouldFallbackToGemini({ reason: "ElevenLabs TTS failed (402): quota exceeded" }), true);
  assert.strictEqual(cloudAiTest.shouldFallbackToGemini({ reason: "ElevenLabs TTS failed (500): server error" }), false);
  assert.strictEqual(cloudAiTest.shouldFallbackToNextGeminiModel({ reason: "Gemini TTS failed (429): quota exceeded" }), true);
  assert.strictEqual(cloudAiTest.shouldFallbackToNextGeminiModel({ reason: "Gemini TTS failed (401): invalid key" }), false);
  const wav = cloudAiTest.wrapPcmAsWav(Buffer.alloc(8));
  assert.strictEqual(wav.slice(0, 4).toString("ascii"), "RIFF");
  assert.strictEqual(wav.slice(8, 12).toString("ascii"), "WAVE");
  assert.strictEqual(wav.readUInt32LE(40), 8);
}

run()
  .then(() => {
    console.log("routing smoke tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
