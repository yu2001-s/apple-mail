import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { escapeHtml } from "../utils/escapeHtml.js";

export { escapeHtml };

const STYLE = `body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#1d1d1f}}
input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}
.row{display:flex;flex-direction:row-reverse;gap:.5rem}.error{color:#d70015}.ok{color:#248a3d}.note{color:#6e6e73;font-size:.9rem}
.accounts{list-style:none;padding:0}.accounts li{display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.5rem 0;border-bottom:1px solid #8884;overflow-wrap:anywhere}
.accounts li>div{flex:1;min-width:0}.accounts form{margin:0;flex:none}.accounts button{width:auto;margin:0}
.nickname{display:flex;gap:.4rem;margin-top:.4rem}.nickname input{margin:0;padding:.35rem;flex:1;min-width:0}.nickname button{padding:.35rem .7rem}`;

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>${body}</body></html>`;
}

/** The owner approval page. Everything from the client is escaped. */
export function consentPage(details: ConsentDescription, handle: string, error?: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on a computer.</strong> Continue only if you just started connecting from it.</p>"
    : "";
  return page(
    "Authorize iCloud Mail",
    `<h1>Authorize iCloud Mail</h1>
<p><strong>${name}</strong> is requesting access to read, draft and send mail from this account. ${origin}</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>Owner password<input type="password" name="password" autocomplete="current-password" autofocus></label>
<div class="row"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></div>
</form>`
  );
}

/** Ask again after a wrong password; the consent handle stays valid until used. */
export function retryPage(handle: string, error: string): string {
  return page(
    "Authorize iCloud Mail",
    `<h1>Authorize iCloud Mail</h1>
<p class="error">${escapeHtml(error)}</p>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>Owner password<input type="password" name="password" autocomplete="current-password" autofocus></label>
<div class="row"><button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></div>
</form>`
  );
}

export function messagePage(message: string, status = 400): Response {
  return new Response(page("iCloud Mail", `<p>${escapeHtml(message)}</p>`), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
