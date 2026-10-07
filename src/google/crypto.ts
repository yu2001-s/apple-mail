/**
 * Seal Google refresh tokens before they reach storage. A refresh token grants
 * lasting access to a whole mailbox and calendar, so KV only ever holds
 * AES-GCM ciphertext bound to the account it belongs to.
 */
const VERSION = "v1";

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Derive the AES-256-GCM key from a high-entropy secret (CONNECTOR_SECRET_KEY). */
export async function importSecretKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("CONNECTOR_SECRET_KEY must be at least 32 characters.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt `plaintext`; `context` (the account address) must match when opening. */
export async function seal(key: CryptoKey, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${VERSION}.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function open(key: CryptoKey, sealed: string, context: string): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== VERSION || !iv || !data) throw new Error("Stored token has an unknown format.");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(iv, "base64url"),
        additionalData: new TextEncoder().encode(context),
      },
      key,
      Buffer.from(data, "base64url")
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Stored token cannot be decrypted; was CONNECTOR_SECRET_KEY changed?");
  }
}
