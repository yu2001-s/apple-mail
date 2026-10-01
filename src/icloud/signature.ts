export interface SignaturePreferences {
  signatures?: Record<string, string>;
}

interface MailBody {
  from?: string;
  body?: string;
  htmlBody?: string | null;
  includeSignature?: boolean;
}

export function signatureFor(preferences: SignaturePreferences, from: string): string | undefined {
  return Object.entries(preferences.signatures ?? {}).find(
    ([address]) => address.toLowerCase() === from.toLowerCase()
  )?.[1];
}

function normalized(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function hasSignature(text: string, signature: string): boolean {
  return `\n${normalized(text)}\n`.includes(`\n${normalized(signature)}\n`);
}

function plainSignature(body: string, signature: string): string {
  // Only inspect the new message. A signature in quoted history does not count.
  const quote = body.search(
    /^(?:On .+ wrote:|在.+(?:寫道|写道)[：:]|>[^\n]*|[-]{2,}\s*Original Message\s*[-]{2,})\r?$/im
  );
  const head = quote < 0 ? body : body.slice(0, quote);
  if (hasSignature(head, signature)) return body;
  const signed = [head.trimEnd(), signature.trimEnd()].filter(Boolean).join("\n\n");
  return quote < 0 ? signed : `${signed}\n\n${body.slice(quote)}`;
}

function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>|<\/(?:div|p|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);|&#x([\da-f]+);|&(nbsp|amp|lt|gt|quot|apos);/gi, (_, decimal, hex, named) => {
      if (decimal || hex) {
        const code = parseInt(decimal || hex, decimal ? 10 : 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return (
        { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>
      )[named.toLowerCase()];
    });
}

function htmlSignature(html: string, signature: string): string {
  const quote = html.search(
    /<blockquote\b|<div\b[^>]*class=["'][^"']*(?:gmail_quote|yahoo_quoted)/i
  );
  const head = quote < 0 ? html : html.slice(0, quote);
  if (hasSignature(htmlText(head), signature)) return html;
  const escaped = signature
    .trimEnd()
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
    )
    .join("<br>");
  const block = `<div data-poieti-signature="true" style="margin-top:1em">${escaped}</div>`;
  const closing = html.search(/<\/body\s*>|<\/html\s*>/i);
  const at = quote >= 0 ? quote : closing >= 0 ? closing : html.length;
  return `${html.slice(0, at)}${block}${html.slice(at)}`;
}

/** Apply before preview/save, never at send time; omitted body fields stay omitted. */
export function withSignature<T extends MailBody>(
  input: T,
  preferences: SignaturePreferences,
  defaultFrom: string
): Omit<T, "includeSignature"> {
  const { includeSignature = true, ...mail } = input;
  const signature = signatureFor(preferences, mail.from ?? defaultFrom);
  if (!includeSignature || !signature?.trim()) return mail;
  if (typeof mail.body === "string") mail.body = plainSignature(mail.body, signature);
  // An empty HTML body asks for no HTML part; leave it empty.
  if (mail.htmlBody) mail.htmlBody = htmlSignature(mail.htmlBody, signature);
  return mail;
}
