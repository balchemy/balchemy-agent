import { C } from "./colors.js";
import type { CliFlags } from "./cli-options.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonEnvelope {
  ok: boolean;
  command: string;
  version: string;
  data: JsonValue;
  warnings: string[];
  error: JsonValue;
}

export interface Reporter {
  readonly flags: CliFlags;
  write: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
  json: (envelope: JsonEnvelope) => void;
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  { pattern: /\bkey-[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  { pattern: /\bbalc_[A-Za-z0-9_-]{8,}\b/g, replacement: "[redacted]" },
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~-]+/gi, replacement: "$1[redacted]" },
  { pattern: /([?&](?:api_key|apikey|token|secret|key)=)[^\s&]+/gi, replacement: "$1[redacted]" },
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, { pattern, replacement }) => current.replace(pattern, replacement),
    value,
  );
}

export function redactJsonValue(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonValue(item)]),
    );
  }
  return null;
}

export function createReporter(flags: CliFlags): Reporter {
  const write = (message: string): void => {
    if (!flags.quiet && !flags.json) process.stdout.write(redactSecrets(message));
  };

  return {
    flags,
    write,
    info(message: string): void {
      if (!flags.quiet && !flags.json) process.stdout.write(redactSecrets(message));
    },
    warn(message: string): void {
      if (!flags.json) process.stderr.write(redactSecrets(message));
    },
    error(message: string): void {
      if (!flags.json) process.stderr.write(redactSecrets(message));
    },
    debug(message: string): void {
      if (flags.debug && !flags.json) process.stderr.write(redactSecrets(`${C.D}${message}${C.R}`));
    },
    json(envelope: JsonEnvelope): void {
      process.stdout.write(`${JSON.stringify(redactJsonValue(envelope), null, 2)}\n`);
    },
  };
}

export function jsonEnvelope(params: {
  ok: boolean;
  command: string;
  version: string;
  data?: JsonValue;
  warnings?: string[];
  error?: JsonValue;
}): JsonEnvelope {
  return {
    ok: params.ok,
    command: params.command,
    version: params.version,
    data: params.data ?? null,
    warnings: params.warnings ?? [],
    error: params.error ?? null,
  };
}

export function compactValue(value: string, head = 28, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid-endpoint";
  }
}
