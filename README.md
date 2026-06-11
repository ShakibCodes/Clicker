# L.A.R.V.I.S.

**Live Adaptive Reasoning and Voice Intelligence System**

L.A.R.V.I.S. is a desktop voice companion that stays with you as a lightweight overlay, listens on demand, understands what is happening on your screen, and routes your request to the right capability: casual conversation, web knowledge, app launching, browser tasks, Gmail, Google Calendar, guided UI tours, or spoken replies.

There is a small wink here to JARVIS from Iron Man: not the armor, not the billionaire lab, just the feeling of a calm intelligence nearby when your hands are already busy.

This project combines a **Next.js identity surface** with an **Electron-powered Windows cursor overlay**. The overlay follows the cursor, expands into a compact control notch, captures voice, transcribes speech through Groq, reasons over the request, and speaks back through ElevenLabs with Gemini TTS as a fallback.

---

## Video

<!-- Add your demo video here. -->

---

## What It Does

L.A.R.V.I.S. is built to feel less like a command palette and more like a present desktop assistant.

| Capability | What it means |
| --- | --- |
| Voice commands | Press the global shortcut, speak naturally, and let the assistant route the request. |
| Live cursor overlay | A transparent always-on-top Electron overlay follows your cursor and shows listening, processing, speaking, and guided-tour states. |
| Adaptive reasoning | Groq text models classify requests into chat, commands, web answers, Gmail, Calendar, guided tours, and UI location tasks. |
| Speech-to-text | Groq Whisper transcription turns voice clips into actionable text. |
| Natural voice output | ElevenLabs is the primary voice provider, with Gemini TTS fallback for quota, billing, or rate-limit failures. |
| Web knowledge | L.A.R.V.I.S. can answer fresh web-style questions through the project's web knowledge route. |
| App and browser actions | Open apps, launch websites, perform common browser tasks, and search from voice. |
| Gmail integration | Connect Google, enable Gmail, ask about recent/important emails, replies, and draft responses. |
| Google Calendar integration | Connect Google Calendar, ask about meetings, schedules, and free/busy windows. |
| Guided UI tours | Ask him to explain visible software or locate a UI element, and he points to the relevant areas on-screen. |

---

## How To Use It

Start the Windows overlay:

```bash
pnpm run cursor:windows
```

Then use these shortcuts:

| Shortcut | Action |
| --- | --- |
| `Ctrl + Shift + V` | Start or stop a voice command. |
| `Ctrl + Shift + X` | Quit the overlay. |

Move your cursor near the small notch at the top center of the screen to open the control panel. From there you can inspect voice provider status and connect integrations.

Example things to say:

```text
Open Gmail and GitHub.
Search the web for the latest React news.
What meetings do I have today?
Do I have any important emails?
Write a short reply from my side.
Explain this software.
Find the run button.
Change cursor color to green.
Are you there?
```

---

## Running On Your Own Device

### 1. Requirements

- Windows, because the desktop overlay currently uses Windows-oriented Electron behavior and commands.
- Node.js 22 or newer is recommended for this codebase.
- pnpm, because the project includes `pnpm-lock.yaml` and was verified with pnpm.
- Your own API keys and OAuth credentials for the services listed below.

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Create `.env.local`

Create a `.env.local` file in the project root.

```env
# Groq: speech-to-text, planning, chat, web answers, visual reasoning
GROQ_API_KEY=your_groq_api_key

# Optional split Groq keys if you want separate keys for STT and text
GROQ_AI_API_FOR_SPEECHTOTEXT=your_groq_speech_key
GROQ_AI_API_FOR_TEXT=your_groq_text_key

# ElevenLabs: primary spoken voice
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=your_elevenlabs_voice_id
ELEVENLABS_MODEL_ID=eleven_multilingual_v2

# Gemini / Google AI Studio: fallback TTS
GEMINI_API_KEY=your_gemini_api_key
GEMINI_TTS_MODEL_ID=gemini-3.1-flash-tts-preview
GEMINI_TTS_MODEL_IDS=gemini-3.1-flash-tts-preview,gemini-2.5-flash-preview-tts
GEMINI_TTS_VOICE_NAME=Kore

# Google OAuth: required for Google Account, Gmail, and Calendar integrations
GOOGLE_OAUTH_CLIENT_ID=your_google_oauth_client_id
GOOGLE_OAUTH_CLIENT_SECRET=your_google_oauth_client_secret
```

You do not need to fill every optional model or voice setting. The code has defaults for ElevenLabs voice/model and Gemini TTS model/voice. You do need real provider credentials for the features you want to use.

### 4. API Keys And Credentials

| Variable | Provider | Required for |
| --- | --- | --- |
| `GROQ_API_KEY` | Groq | General Groq access for transcription, chat, planning, web answers, and visual reasoning. |
| `GROQ_AI_API_FOR_SPEECHTOTEXT` | Groq | Optional override specifically for speech-to-text. |
| `GROQ_AI_API_FOR_TEXT` | Groq | Optional override specifically for text reasoning and summaries. |
| `ELEVENLABS_API_KEY` | ElevenLabs | Primary text-to-speech voice output. |
| `ELEVEN_LABS_API_KEY` | ElevenLabs | Supported alias for `ELEVENLABS_API_KEY`. |
| `ELEVENLABS_VOICE_ID` | ElevenLabs | Optional voice selection. Defaults to `EXAVITQu4vr4xnSDxMaL`. |
| `ELEVENLABS_MODEL_ID` | ElevenLabs | Optional TTS model. Defaults to `eleven_multilingual_v2`. |
| `GEMINI_API_KEY` | Google AI Studio / Gemini | Gemini fallback text-to-speech. |
| `GOOGLE_AI_API_KEY` | Google AI Studio / Gemini | Supported alias for `GEMINI_API_KEY`. |
| `GEMINI_TTS_MODEL_ID` | Google AI Studio / Gemini | Optional primary Gemini TTS model. |
| `GEMINI_TTS_MODEL_IDS` | Google AI Studio / Gemini | Optional comma-separated fallback model list. |
| `GEMINI_TTS_VOICE_NAME` | Google AI Studio / Gemini | Optional Gemini voice name. Defaults to `Kore`. |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud | Google account connection for Gmail and Calendar. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud | Google account connection for Gmail and Calendar. |

For Google OAuth, configure a desktop/web OAuth client that allows the local callback opened by the app. The app starts a temporary local server on `127.0.0.1` during the connection flow.

### 5. Run The Project

Run the identity page:

```bash
pnpm run dev
```

Open:

```text
http://localhost:3000
```

Run the desktop overlay:

```bash
pnpm run cursor:windows
```

Build the Next.js app:

```bash
pnpm run build
```

Run routing smoke tests:

```bash
pnpm run test:routing
```

---

## Project Structure

```text
app/
  layout.tsx                  Next.js metadata and root layout
  page.tsx                    L.A.R.V.I.S. identity/context surface
  globals.css                 Tailwind and global theme

cursor-overlay/
  main.js                     Electron entry, overlay window, shortcuts, IPC
  overlay.html                Transparent overlay UI and notch panel
  overlay.js                  Cursor movement, microphone capture, voice UI
  lib/
    assistant-identity.js     Shared L.A.R.V.I.S. name and context
    cloud-ai.js               Groq STT/planning/vision and cloud TTS routing
    buddy-chat.js             Casual voice companion responses
    conversation-router.js    Routes transcripts into the right capability
    browser-commands.js       Website/app/browser command parsing
    gmail-integration.js      Gmail read/summarize/draft support
    google-calendar-integration.js
                               Calendar event/free-time support
    google-account-integration.js
                               Google OAuth and token handling
    guided-tour.js            On-screen guided tour controller
```

---

## NPM Scripts

| Script | Purpose |
| --- | --- |
| `pnpm run dev` | Start the Next.js development server. |
| `pnpm run build` | Build the Next.js app for production. |
| `pnpm run start` | Start the production Next.js server after building. |
| `pnpm run lint` | Run ESLint. |
| `pnpm run cursor:windows` | Start the Electron desktop overlay. |
| `pnpm run test:routing` | Run routing smoke tests for commands, Gmail, Calendar, and conversation handling. |

---

## Notes For Google Integrations

Gmail and Google Calendar are not enabled by only adding API keys. You also need Google OAuth credentials and must connect the account inside the overlay:

1. Start the overlay with `pnpm run cursor:windows`.
2. Move the cursor near the top-center notch.
3. Open **Integrations**.
4. Click **Connect** for Google Account.
5. Enable **Gmail** and/or **Google Calendar**.

The app requests these scopes when needed:

```text
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/calendar.readonly
```

---

## Troubleshooting

**The overlay starts but voice does not work**

Check `GROQ_API_KEY` or the split Groq keys. Speech-to-text needs Groq credentials.

**L.A.R.V.I.S. replies in text but does not speak**

Check `ELEVENLABS_API_KEY`. If ElevenLabs is unavailable, check `GEMINI_API_KEY` for fallback TTS.

**Gmail or Calendar says it is not connected**

Add `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, restart the overlay, then connect Google from the Integrations panel.

**The build fails after dependency changes**

Repair dependencies from the lockfile:

```bash
pnpm install
pnpm run build
```

**The global shortcut does nothing**

Make sure the Electron overlay is running. Some apps can capture global shortcuts first, so try focusing the desktop and pressing `Ctrl + Shift + V` again.

---

## Status

L.A.R.V.I.S. is actively evolving. The current codebase already includes the core identity, overlay, voice pipeline, routing, web knowledge, Gmail, Google Calendar, and guided-tour foundations. The next natural step is packaging the Electron overlay into a standalone desktop installer.
