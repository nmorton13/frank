const MAX_JSON_BYTES = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function withSecurityHeaders(
  response: Response,
  options: {
    isHtml?: boolean;
    isRedirect?: boolean;
    isJson?: boolean;
  } = {},
): Response {
  const headers = new Headers(response.headers);

  // Always apply these.
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "strict-transport-security",
    "max-age=31536000; includeSubDomains; preload",
  );

  // CSP — tighten for HTML, reasonable default for JSON/assets.
  if (options.isHtml) {
    headers.set(
      "content-security-policy",
      [
        "default-src 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "object-src 'none'",
        "connect-src 'self'",
      ].join("; "),
    );
  } else if (options.isRedirect) {
    headers.delete("content-security-policy");
  } else {
    headers.set(
      "content-security-policy",
      "default-src 'self'; object-src 'none'; frame-ancestors 'none'",
    );
  }

  if (options.isJson) {
    headers.set("content-type", "application/json; charset=utf-8");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(data: unknown, status = 200): Response {
  return withSecurityHeaders(
    Response.json(data, {
      status,
      headers: {
        "cache-control": "no-store",
      },
    }),
    { isJson: true },
  );
}

export function htmlResponse(html: string): Response {
  return withSecurityHeaders(
    new Response(html, {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    }),
    { isHtml: true },
  );
}

export function redirectResponse(location: string, status = 303): Response {
  return withSecurityHeaders(
    new Response(null, {
      status,
      headers: { location, "cache-control": "no-store" },
    }),
    { isRedirect: true },
  );
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError(413, "Request body is too large");
  }
  if (!request.body) throw new HttpError(400, "JSON body is required");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "JSON body must be an object");
  }
  return value as Record<string, unknown>;
}

export function stringField(
  body: Record<string, unknown>,
  name: string,
  options: { max: number; required?: boolean } = { max: 500 },
): string | undefined {
  const value = body[name];
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${name} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > options.max) {
    throw new HttpError(400, `${name} is too long`);
  }
  return normalized;
}

export function parseCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const segment of (request.headers.get("cookie") ?? "").split(";")) {
    const [rawName, ...parts] = segment.trim().split("=");
    if (!rawName) continue;
    cookies.set(rawName, decodeURIComponent(parts.join("=")));
  }
  return cookies;
}

/**
 * Reject requests whose Origin header does not match the trusted canonical
 * origin for this deployment. More secure than comparing against
 * `new URL(request.url).origin`, which accepts any hostname that reaches the
 * Worker (workers.dev alias, preview host, unintended custom domain).
 */
export function requireSameOrigin(
  request: Request,
  trustedOrigin: string,
): void {
  const provided = request.headers.get("origin");
  try {
    if (
      !provided ||
      new URL(provided).origin !== new URL(trustedOrigin).origin
    ) {
      throw new HttpError(403, "Invalid request origin");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Invalid request origin");
  }
}

export function htmlEscape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}
