/**
 * Persists agent credentials to ~/.balchemy/agents.enc (AES-256-GCM encrypted).
 *
 * Key derivation: PBKDF2 from machine hostname + username + fixed salt,
 * or from BALCHEMY_MASTER_KEY env var if set.
 *
 * Migration: automatically encrypts plaintext agents.json / agent.json on first read.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const STORE_DIR = path.join(os.homedir(), ".balchemy");
const ENCRYPTED_STORE_PATH = path.join(STORE_DIR, "agents.enc");
const LEGACY_STORE_PATH = path.join(STORE_DIR, "agents.json");
const OLD_STORE_PATH = path.join(STORE_DIR, "agent.json"); // v0.1 single-agent format

const ALGORITHM = "aes-256-gcm";
const SALT = "balchemy-agent-store-v1";
const PBKDF2_ITERATIONS = 100_000;

export interface StoredAgent {
  publicId: string;
  mcpEndpoint: string;
  apiKey: string;
  masterKey?: string;
  llmProvider: string;
  llmApiKey: string;
  llmModel?: string;
  llmBaseUrl?: string;
  maxDailyLlmCost?: number;
  strategy: string;
  shadowMode: boolean;
  wallets?: { solana?: string; base?: string };
  createdAt: string;
  name?: string;
}

interface StoreData {
  activeId: string | null;
  agents: StoredAgent[];
}

// ── Encryption helpers ─────────────────────────────────────────────────────────

function deriveKey(): Buffer {
  const passphrase =
    process.env.BALCHEMY_MASTER_KEY ??
    `${os.hostname()}:${os.userInfo().username}:balchemy`;
  return crypto.pbkdf2Sync(passphrase, SALT, PBKDF2_ITERATIONS, 32, "sha256");
}

function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: base64(iv):base64(tag):base64(encrypted)
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(ciphertext: string): string {
  const key = deriveKey();
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted store format");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

// ── Legacy migration ───────────────────────────────────────────────────────────

/**
 * Attempt to read a plaintext JSON file, parse it as StoreData or single agent.
 * Returns null if the file doesn't exist or is unparseable.
 */
function readLegacyFile(filePath: string): StoreData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw) as StoreData | StoredAgent;

    // Multi-agent format
    if ("agents" in data && Array.isArray((data as StoreData).agents)) {
      return data as StoreData;
    }

    // Single-agent format
    const agent = data as StoredAgent;
    if (agent.publicId) {
      return { activeId: agent.publicId, agents: [agent] };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Migrate plaintext stores to encrypted format.
 * Reads agents.json and agent.json, merges them, writes agents.enc,
 * then deletes the plaintext files.
 */
function migrateLegacyStores(): StoreData | null {
  const fromMulti = readLegacyFile(LEGACY_STORE_PATH);
  const fromSingle = readLegacyFile(OLD_STORE_PATH);

  if (!fromMulti && !fromSingle) return null;

  // Merge: multi-agent store takes precedence, single-agent merged in if not duplicate
  const merged: StoreData = fromMulti ?? { activeId: null, agents: [] };
  if (fromSingle) {
    for (const agent of fromSingle.agents) {
      if (!merged.agents.some((a) => a.publicId === agent.publicId)) {
        merged.agents.push(agent);
      }
    }
    if (!merged.activeId && fromSingle.activeId) {
      merged.activeId = fromSingle.activeId;
    }
  }

  // Write encrypted
  writeStore(merged);

  // Remove plaintext files
  try {
    if (fs.existsSync(LEGACY_STORE_PATH)) fs.unlinkSync(LEGACY_STORE_PATH);
  } catch { /* best effort */ }
  try {
    if (fs.existsSync(OLD_STORE_PATH)) fs.unlinkSync(OLD_STORE_PATH);
  } catch { /* best effort */ }

  return merged;
}

// ── Store read/write ───────────────────────────────────────────────────────────

function readStore(): StoreData {
  try {
    // Try encrypted store first
    if (fs.existsSync(ENCRYPTED_STORE_PATH)) {
      const raw = fs.readFileSync(ENCRYPTED_STORE_PATH, "utf8");
      const json = decrypt(raw);
      const data = JSON.parse(json) as StoreData;
      if (Array.isArray(data.agents)) return data;
    }

    // Attempt migration from plaintext
    const migrated = migrateLegacyStores();
    if (migrated) return migrated;

    return { activeId: null, agents: [] };
  } catch {
    // Decryption failure (machine changed, key changed, etc.)
    // Try legacy migration as fallback
    try {
      const migrated = migrateLegacyStores();
      if (migrated) return migrated;
    } catch { /* ignore */ }

    return { activeId: null, agents: [] };
  }
}

function writeStore(data: StoreData): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  }
  const json = JSON.stringify(data, null, 2);
  const encrypted = encrypt(json);
  fs.writeFileSync(ENCRYPTED_STORE_PATH, encrypted, { mode: 0o600 });
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function saveAgent(agent: StoredAgent): void {
  const store = readStore();
  const idx = store.agents.findIndex((a) => a.publicId === agent.publicId);
  if (idx >= 0) {
    store.agents[idx] = agent;
  } else {
    store.agents.push(agent);
  }
  store.activeId = agent.publicId;
  writeStore(store);
}

/** Load the active agent, or null if none. */
export function loadAgent(): StoredAgent | null {
  const store = readStore();
  if (!store.activeId) return store.agents[0] ?? null;
  return (
    store.agents.find((a) => a.publicId === store.activeId) ??
    store.agents[0] ??
    null
  );
}

/** List all saved agents. */
export function listAgents(): StoredAgent[] {
  return readStore().agents;
}

/** Clear the active agent (but keep the list). */
export function clearAgent(): void {
  const store = readStore();
  store.activeId = null;
  writeStore(store);
}

/** Delete a specific agent from the store. */
export function deleteAgent(publicId: string): void {
  const store = readStore();
  store.agents = store.agents.filter((a) => a.publicId !== publicId);
  if (store.activeId === publicId) {
    store.activeId = store.agents[0]?.publicId ?? null;
  }
  writeStore(store);
}

/** Set active agent by publicId. */
export function setActiveAgent(publicId: string): boolean {
  const store = readStore();
  const found = store.agents.find((a) => a.publicId === publicId);
  if (!found) return false;
  store.activeId = publicId;
  writeStore(store);
  return true;
}

export function getStorePath(): string {
  return ENCRYPTED_STORE_PATH;
}
