const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

const SENSITIVE_KEY_PATTERN = /(^|[-_.])(?:auth|authorization|cookie|token|secret|key|credential|password|private|seed|mnemonic|signature|session|wallet|address|email|username|api[-_]?key|master[-_]?key|dsn|connection[-_]?string)(?:[-_.]|$)/i;

const SECRET_LIKE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\bBasic\s+[A-Za-z0-9+/=._~-]+/gi,
  /\bbalc_[A-Za-z0-9_-]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  /\b0x[a-fA-F0-9]{40}\b/g,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s'"<>]+/gi,
  /(?:[?&](?:token|api_key|apikey|secret|key|signature|password)=)[^\s&#'"<>]+/gi,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  SENSITIVE_KEY_PATTERN.lastIndex = 0;
  return SENSITIVE_KEY_PATTERN.test(normalized);
}

export function redactSecretLikeText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_LIKE_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
}

export function sanitizePublicErrorDetails(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return "[MAX_DEPTH_REACHED]";
  }
  if (typeof value === "string") {
    return redactSecretLikeText(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSecretLikeText(value.message),
    };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizePublicErrorDetails(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return redactSecretLikeText(String(value));
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return redactSecretLikeText(String(value));
  }

  const output: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value).slice(0, 80)) {
    output[key.slice(0, 96)] = isSensitiveKey(key)
      ? REDACTED
      : sanitizePublicErrorDetails(nestedValue, depth + 1);
  }
  return output;
}
