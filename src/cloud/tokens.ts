export type TokenKind = "agent" | "claim" | "session" | "verify" | "login";

export interface OpaqueToken {
  token: string;
  hash: ArrayBuffer;
  prefix: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

export async function hashToken(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
}

export async function hashText(value: string): Promise<string> {
  const bytes = new Uint8Array(await hashToken(value));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function keyedHashText(secret: string, value: string): Promise<string> {
  const bytes = await hmacBytes(secret, value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function deriveOpaqueToken(
  kind: TokenKind,
  secret: string,
  context: string,
): Promise<OpaqueToken> {
  const token = `frank_${kind}_${base64Url(await hmacBytes(secret, `${kind}:${context}`))}`;
  return {
    token,
    hash: await hashToken(token),
    prefix: token.slice(0, 20),
  };
}

export async function newOpaqueToken(kind: TokenKind): Promise<OpaqueToken> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = `frank_${kind}_${base64Url(bytes)}`;
  return {
    token,
    hash: await hashToken(token),
    prefix: token.slice(0, 20),
  };
}

export function newId(
  kind: "workspace" | "user" | "credential" | "claim" | "session" | "auth" | "email",
): string {
  const prefixes = {
    workspace: "wsp",
    user: "usr",
    credential: "cred",
    claim: "clm",
    session: "ses",
    auth: "auth",
    email: "eml",
  } as const;
  return `${prefixes[kind]}_${crypto.randomUUID()}`;
}
