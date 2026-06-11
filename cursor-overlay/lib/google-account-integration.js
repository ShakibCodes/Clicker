/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const http = require("http");
const path = require("path");
const { URLSearchParams } = require("url");
const { ASSISTANT_NAME } = require("./assistant-identity");
const { getGoogleOAuthClientId, getGoogleOAuthClientSecret } = require("./env");

const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const BASE_SCOPES = ["https://www.googleapis.com/auth/userinfo.email"];
const GOOGLE_SERVICE_SCOPES = {
  calendar: ["https://www.googleapis.com/auth/calendar.readonly"],
  gmail: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
};

function createGoogleAccountIntegration({ getUserDataPath, shell }) {
  const tokenStorePath = () => path.join(getUserDataPath(), "google-account-token.json");

  function getStatus() {
    const token = readToken();
    const connected = Boolean(token?.refresh_token || token?.access_token);
    return {
      connected,
      email: token?.email || "",
      enabledServices: getEnabledServices(token),
      scopes: token?.scopes || parseScopeString(token?.scope),
      services: {
        calendar: getServiceStatus("calendar", token),
        gmail: getServiceStatus("gmail", token),
      },
    };
  }

  function getServiceStatus(serviceKey, token = readToken()) {
    const scopes = token?.scopes || parseScopeString(token?.scope);
    const enabledServices = getEnabledServices(token);
    return {
      connected:
        Boolean(token?.refresh_token || token?.access_token) &&
        enabledServices.includes(serviceKey) &&
        hasScopes(scopes, GOOGLE_SERVICE_SCOPES[serviceKey] || []),
      scopes: GOOGLE_SERVICE_SCOPES[serviceKey] || [],
    };
  }

  async function connect() {
    const token = await authorize(BASE_SCOPES, "Google Account connected.");
    return {
      ok: true,
      email: token.email || "",
      message: token.email ? `Google connected as ${token.email}.` : "Google connected.",
    };
  }

  async function enableService(serviceKey) {
    const serviceScopes = GOOGLE_SERVICE_SCOPES[serviceKey] || [];
    if (serviceScopes.length === 0) {
      return { ok: false, message: "Unknown Google service." };
    }

    const existing = readToken();
    const existingScopes = existing?.scopes || parseScopeString(existing?.scope);
    const existingEnabledServices = getEnabledServices(existing);
    if (existing && existingEnabledServices.includes(serviceKey) && hasScopes(existingScopes, serviceScopes)) {
      return {
        ok: true,
        email: existing.email || "",
        message: `${formatServiceName(serviceKey)} is already enabled.`,
      };
    }

    const token = await authorize([...BASE_SCOPES, ...serviceScopes], `${formatServiceName(serviceKey)} enabled.`);
    writeToken({
      ...token,
      enabledServices: mergeScopes(getEnabledServices(token), [serviceKey]),
    });
    return {
      ok: true,
      email: token.email || "",
      message: `${formatServiceName(serviceKey)} enabled${token.email ? ` for ${token.email}` : ""}.`,
    };
  }

  function disableService(serviceKey) {
    const token = readToken();
    if (!token) {
      return { ok: true, message: `${formatServiceName(serviceKey)} is already off.` };
    }

    writeToken({
      ...token,
      enabledServices: getEnabledServices(token).filter((enabledService) => enabledService !== serviceKey),
    });
    return { ok: true, message: `${formatServiceName(serviceKey)} turned off.` };
  }

  function disconnect() {
    const filePath = tokenStorePath();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return { ok: true, message: "Google disconnected." };
  }

  async function fetchJson(serviceKey, baseUrl, endpoint, options = {}) {
    const token = await getValidToken(serviceKey);
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${formatServiceName(serviceKey)} API failed (${response.status}): ${body}`);
    }

    return response.json();
  }

  async function getValidToken(serviceKey = "") {
    const token = readToken();
    if (!token) {
      throw new Error("Google is not connected.");
    }

    const requiredScopes = serviceKey ? GOOGLE_SERVICE_SCOPES[serviceKey] || [] : BASE_SCOPES;
    const currentScopes = token.scopes || parseScopeString(token.scope);
    if (serviceKey && !getEnabledServices(token).includes(serviceKey)) {
      throw new Error(`${formatServiceName(serviceKey)} is turned off for this Google account.`);
    }
    if (!hasScopes(currentScopes, requiredScopes)) {
      throw new Error(`${formatServiceName(serviceKey)} is not enabled for this Google account.`);
    }

    if (token.access_token && Number(token.expiry_date || 0) - Date.now() > TOKEN_EXPIRY_SKEW_MS) {
      return token;
    }

    if (!token.refresh_token) {
      throw new Error("Google token expired. Please reconnect Google.");
    }

    const refreshed = await refreshAccessToken(token.refresh_token);
    const nextToken = {
      ...token,
      ...refreshed,
      refresh_token: refreshed.refresh_token || token.refresh_token,
      savedAt: Date.now(),
      scopes: mergeScopes(token.scopes || parseScopeString(token.scope), parseScopeString(refreshed.scope)),
    };
    writeToken(nextToken);
    return nextToken;
  }

  async function authorize(requestedScopes, successTitle) {
    const client = getOAuthClientConfig();
    if (!client.ok) {
      return client;
    }

    const existing = readToken();
    const requested = mergeScopes(BASE_SCOPES, requestedScopes);
    const authResult = await runLoopbackOAuth(client, shell, requested, successTitle);
    const profile = await googleUserInfoFetch(authResult).catch(() => null);
    const token = {
      ...existing,
      ...authResult,
      email: profile?.email || existing?.email || "",
      enabledServices: getEnabledServices(existing),
      refresh_token: authResult.refresh_token || existing?.refresh_token || "",
      savedAt: Date.now(),
      scopes: mergeScopes(existing?.scopes || parseScopeString(existing?.scope), parseScopeString(authResult.scope), requested),
    };
    writeToken(token);
    return token;
  }

  async function refreshAccessToken(refreshToken) {
    const client = getOAuthClientConfig();
    if (!client.ok) {
      throw new Error(client.message);
    }

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google refresh failed (${response.status}): ${body}`);
    }

    const data = await response.json();
    return {
      ...data,
      expiry_date: Date.now() + Number(data.expires_in || 0) * 1000,
    };
  }

  function readToken() {
    try {
      const filePath = tokenStorePath();
      if (!fs.existsSync(filePath)) {
        return null;
      }
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return null;
    }
  }

  function writeToken(token) {
    const filePath = tokenStorePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(token, null, 2), "utf8");
  }

  return {
    connect,
    disconnect,
    disableService,
    enableService,
    fetchJson,
    getStatus,
    getValidToken,
  };
}

async function runLoopbackOAuth(client, shell, scopes, successTitle) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let redirectUri = "";
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Google connection timed out."));
    }, 2 * 60 * 1000);

    server.on("request", async (request, response) => {
      try {
        const requestUrl = new URL(request.url, `http://${request.headers.host}`);
        if (requestUrl.pathname !== "/oauth2callback") {
          response.writeHead(404);
          response.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code");
        const error = requestUrl.searchParams.get("error");
        if (error || !code) {
          throw new Error(error || "No OAuth code returned.");
        }

        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<h2>${escapeHtml(successTitle || "Google connected.")}</h2><p>You can close this tab and return to ${escapeHtml(ASSISTANT_NAME)}.</p>`);
        clearTimeout(timeout);
        server.close();

        const token = await exchangeCodeForToken(client, code, redirectUri);
        resolve(token);
      } catch (error) {
        clearTimeout(timeout);
        server.close();
        reject(error);
      }
    });

    server.listen(0, "127.0.0.1", () => {
      redirectUri = getRedirectUri(server);
      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.searchParams.set("client_id", client.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", scopes.join(" "));
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("include_granted_scopes", "true");
      authUrl.searchParams.set("prompt", "consent");
      shell.openExternal(authUrl.toString());
    });
  });
}

function getRedirectUri(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}/oauth2callback`;
}

async function exchangeCodeForToken(client, code, redirectUri) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google OAuth failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return {
    ...data,
    expiry_date: Date.now() + Number(data.expires_in || 0) * 1000,
  };
}

async function googleUserInfoFetch(token) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

function getOAuthClientConfig() {
  const clientId = getGoogleOAuthClientId();
  const clientSecret = getGoogleOAuthClientSecret();
  if (!clientId || !clientSecret) {
    return {
      ok: false,
      message: "Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to .env.local first.",
    };
  }

  return {
    clientId,
    clientSecret,
    ok: true,
  };
}

function hasScopes(grantedScopes, requiredScopes) {
  return requiredScopes.every((scope) => grantedScopes.includes(scope));
}

function getEnabledServices(token) {
  if (Array.isArray(token?.enabledServices)) {
    return token.enabledServices.filter((serviceKey) => GOOGLE_SERVICE_SCOPES[serviceKey]);
  }

  const scopes = token?.scopes || parseScopeString(token?.scope);
  return Object.keys(GOOGLE_SERVICE_SCOPES).filter((serviceKey) => hasScopes(scopes, GOOGLE_SERVICE_SCOPES[serviceKey]));
}

function parseScopeString(scopeString) {
  return String(scopeString || "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function mergeScopes(...scopeGroups) {
  return Array.from(
    new Set(
      scopeGroups
        .flat()
        .map((scope) => String(scope || "").trim())
        .filter(Boolean),
    ),
  );
}

function formatServiceName(serviceKey) {
  if (serviceKey === "gmail") {
    return "Gmail";
  }
  if (serviceKey === "calendar") {
    return "Google Calendar";
  }
  return "Google";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  BASE_SCOPES,
  GOOGLE_SERVICE_SCOPES,
  _test: {
    hasScopes,
    mergeScopes,
    parseScopeString,
  },
  createGoogleAccountIntegration,
};
