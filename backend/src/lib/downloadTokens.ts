import crypto from "crypto";

/**
 * HMAC-signed, non-expiring download tokens.
 *
 * The token encodes the opaque storage URI + filename; the backend route
 * `/download/:token` validates the signature and streams the file. This
 * gives persistent links safe to store in chat history without signed-URL
 * expiry or exposing Case Vault credentials to the browser.
 */

const DEV_SECRET = "dev-secret";
const PLACEHOLDER_SECRETS = new Set([
    DEV_SECRET,
    "generate-a-32-byte-random-secret",
    "changeme",
    "REPLACE_ME",
]);

function selectedSecret(): { value: string; source: string } {
    const candidates = [
        ["DOWNLOAD_SIGNING_SECRET", process.env.DOWNLOAD_SIGNING_SECRET],
        ["BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET],
        ["CASE_KEY_ENCRYPTION_SECRET", process.env.CASE_KEY_ENCRYPTION_SECRET],
    ] as const;
    for (const [source, raw] of candidates) {
        const value = raw?.trim();
        if (value) return { source, value };
    }
    return { source: "development fallback", value: DEV_SECRET };
}

export function assertDownloadSigningSecret() {
    const { source, value } = selectedSecret();
    if (process.env.NODE_ENV !== "production") return;
    if (PLACEHOLDER_SECRETS.has(value)) {
        throw new Error(
            `${source} must be set to a strong secret before using download tokens in production.`,
        );
    }
}

function getSecret(): string {
    assertDownloadSigningSecret();
    return selectedSecret().value;
}

function b64urlEncode(buf: Buffer): string {
    return buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function b64urlDecode(s: string): Buffer {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    while (t.length % 4) t += "=";
    return Buffer.from(t, "base64");
}

function timingSafeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function signDownload(path: string, filename: string): string {
    const payload = JSON.stringify({ p: path, f: filename });
    const enc = b64urlEncode(Buffer.from(payload, "utf8"));
    const sig = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    return `${enc}.${b64urlEncode(sig)}`;
}

export function verifyDownload(
    token: string,
): { path: string; filename: string } | null {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [enc, sigEnc] = parts;
    const expected = crypto
        .createHmac("sha256", getSecret())
        .update(enc)
        .digest();
    if (!timingSafeEqStr(sigEnc, b64urlEncode(expected))) return null;
    try {
        const parsed = JSON.parse(b64urlDecode(enc).toString("utf8")) as {
            p: string;
            f: string;
        };
        if (!parsed?.p || !parsed?.f) return null;
        return { path: parsed.p, filename: parsed.f };
    } catch {
        return null;
    }
}

/**
 * Returns a relative download URL (e.g. "/download/abc.def"). The frontend
 * prefixes it with NEXT_PUBLIC_API_BASE_URL when rendering `<a href=…>`.
 */
export function buildDownloadUrl(path: string, filename: string): string {
    return `/download/${signDownload(path, filename)}`;
}
