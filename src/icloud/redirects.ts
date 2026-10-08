/**
 * OAuth callbacks the remote connector will send authorization codes to.
 * Anyone may register a client, so this list is what keeps codes from being
 * delivered to an arbitrary site even before the owner password is checked.
 */
const EXACT = new Set([
  // claude.ai custom connectors (web, desktop and mobile share the account).
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT connectors whose authorization server supports RFC 9207 issuers.
  "https://chatgpt.com/connector_platform_oauth_redirect",
]);
/** ChatGPT's per-connector callback: https://chatgpt.com/connector/oauth/{callback_id}. */
const CHATGPT_CALLBACK = /^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedRedirect(uri: string, extra: Iterable<string> = []): boolean {
  if (EXACT.has(uri) || new Set(extra).has(uri)) return true;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  // Local MCP clients such as Claude Code listen on an ephemeral loopback port.
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return true;
  return (
    url.protocol === "https:" &&
    url.hostname === "chatgpt.com" &&
    !url.port &&
    !url.search &&
    CHATGPT_CALLBACK.test(url.pathname)
  );
}

/**
 * CSP form-action sources for the approval form. Browsers apply form-action
 * to the redirect that follows the submission, so every callback origin the
 * code may be sent to must be listed, not just this server. That includes any
 * host a callback itself redirects to, which must be configured as well.
 */
export function formActionSources(extra: Iterable<string> = []): string {
  const sources = new Set([
    "'self'",
    "https://claude.ai",
    "https://claude.com",
    "https://chatgpt.com",
    "http://localhost:*",
    "http://127.0.0.1:*",
    "http://[::1]:*",
  ]);
  for (const uri of extra) {
    try {
      sources.add(new URL(uri).origin);
    } catch {
      // Ignore malformed settings; they are never allowed as redirects either.
    }
  }
  return [...sources].join(" ");
}

/** Extra exact callbacks from a comma-separated setting. */
export function parseRedirectList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);
}
