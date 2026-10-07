/**
 * Google's OAuth endpoints, used to link an account (authorization code with
 * PKCE, offline access) and to keep its access token fresh.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
export const GOOGLE_SCOPES = ["openid", "email", GMAIL_SCOPE, CALENDAR_SCOPE];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
}

export type Fetch = typeof fetch;

/** A token Google no longer accepts; the account must be linked again. */
export class GoogleReconnectError extends Error {}

export function googleAuthUrl(
  config: GoogleClientConfig,
  options: { redirectUri: string; state: string; codeChallenge: string }
): string {
  const url = new URL(AUTH_URL);
  for (const [key, value] of Object.entries({
    client_id: config.clientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    // Always ask, so Google returns a refresh token even for an account linked before.
    prompt: "consent select_account",
    include_granted_scopes: "true",
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
  }))
    url.searchParams.set(key, value);
  return url.toString();
}

/** A random PKCE verifier and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString("base64url") };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  fetchImpl: Fetch,
  body: Record<string, string>
): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || data.error) {
    const reason = data.error_description || data.error || `HTTP ${response.status}`;
    if (data.error === "invalid_grant") throw new GoogleReconnectError(reason);
    throw new Error(`Google token request failed: ${reason}`);
  }
  return data;
}

export interface LinkedTokens {
  email: string;
  /** Google's stable account ID. */
  sub: string;
  refreshToken: string;
  accessToken: string;
  expiresIn: number;
  scopes: string[];
}

/**
 * Exchange an authorization code. The ID token comes straight from Google's
 * token endpoint over TLS, so its claims are trusted without a signature
 * check (OpenID Connect Core 3.1.3.7), after checking audience and issuer.
 */
export async function exchangeCode(
  config: GoogleClientConfig,
  options: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: Fetch = fetch
): Promise<LinkedTokens> {
  const data = await tokenRequest(fetchImpl, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (!data.refresh_token || !data.access_token || !data.id_token) {
    throw new Error(
      "Google did not return offline access; remove the app at myaccount.google.com/permissions and link again."
    );
  }
  const claims = JSON.parse(
    Buffer.from(data.id_token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}"
  ) as { aud?: string; iss?: string; email?: string; email_verified?: boolean; sub?: string };
  if (
    claims.aud !== config.clientId ||
    !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss ?? "") ||
    !claims.email ||
    claims.email_verified === false ||
    !claims.sub
  ) {
    throw new Error("Google returned an ID token for a different app or an unverified address.");
  }
  return {
    email: claims.email.toLowerCase(),
    sub: claims.sub,
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    scopes: (data.scope ?? "").split(" ").filter(Boolean),
  };
}

export async function refreshAccessToken(
  config: GoogleClientConfig,
  refreshToken: string,
  fetchImpl: Fetch = fetch
): Promise<{ accessToken: string; expiresIn: number }> {
  const data = await tokenRequest(fetchImpl, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (!data.access_token) throw new Error("Google did not return an access token.");
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

/** Revoke a token at Google. Best effort: the token may already be invalid. */
export async function revokeToken(token: string, fetchImpl: Fetch = fetch): Promise<void> {
  await fetchImpl(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}
