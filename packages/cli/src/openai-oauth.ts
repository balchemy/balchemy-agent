/**
 * OpenAI OAuth 2.0 + PKCE authentication for ChatGPT Plus/Pro subscriptions.
 *
 * Uses the same flow as the official Codex CLI:
 *   1. Generate PKCE code_verifier + code_challenge
 *   2. Start localhost callback server
 *   3. Open browser → user logs in with ChatGPT account
 *   4. Exchange auth code for access_token + refresh_token
 *   5. Auto-refresh before expiry
 *
 * Reference: https://developers.openai.com/codex/auth
 */

import * as http from "http";
import * as crypto from "crypto";
import { exec } from "child_process";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPES = "openid profile email offline_access";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  accountId?: string;
}

// ── PKCE Helpers ──────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}

// ── Browser ───────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// ── OAuth Flow ────────────────────────────────────────────────────────────────

/**
 * Run the full OAuth PKCE flow. Opens browser, waits for callback, returns tokens.
 * Rejects after timeoutMs (default 120s).
 */
export function loginWithOpenAI(timeoutMs = 120_000): Promise<OAuthTokens> {
  return new Promise((resolve, reject) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    const state = generateState();

    let server: http.Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (server) server.close();
    };

    timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth login timed out (120s). Try again."));
    }, timeoutMs);

    server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);

      if (url.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorPage(error));
        cleanup();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(errorPage("Invalid callback — state mismatch or missing code."));
        cleanup();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      // Exchange code for tokens
      try {
        const tokens = await exchangeCode(code, codeVerifier);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successPage());
        cleanup();
        resolve(tokens);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(errorPage(err instanceof Error ? err.message : "Token exchange failed"));
        cleanup();
        reject(err);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      // Build auth URL
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: "code",
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const authUrl = `${AUTH_URL}?${params.toString()}`;
      openBrowser(authUrl);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${CALLBACK_PORT} is in use. Close other apps and try again.`));
      } else {
        reject(err);
      }
    });
  });
}

// ── Token Exchange ────────────────────────────────────────────────────────────

async function exchangeCode(code: string, codeVerifier: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    id_token?: string;
  };

  // Extract accountId from access token (JWT payload)
  let accountId: string | undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(data.access_token.split(".")[1], "base64").toString(),
    );
    accountId = payload.sub ?? payload.account_id;
  } catch {
    // non-critical
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    accountId,
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

// ── HTML Pages ────────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS when interpolating
 * untrusted strings (e.g. OAuth error parameters) into HTML responses.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function successPage(): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a0a;color:#00acb0">
    <div style="text-align:center">
      <h1>Logged in</h1>
      <p style="color:#888">You can close this tab and return to the terminal.</p>
    </div></body></html>`;
}

function errorPage(msg: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;background:#0a0a0a;color:#e55">
    <div style="text-align:center">
      <h1>Login failed</h1>
      <p style="color:#888">${escapeHtml(msg)}</p>
    </div></body></html>`;
}
