/** Stops a secret typed or pasted into chat before it reaches the model. This is a best-effort pattern check, not a
 * guarantee: the owner is told never to paste secrets into chat. Secrets belong only in the masked fields
 * (wallet passphrase, private key import, API key, RPC URL), which never enter chat. The check is deliberately broad:
 * a false alarm only asks the owner to rephrase. It returns the kind, never the matched text. */
export type PrivateSecretKind = "private_key" | "seed_phrase" | "api_key" | "credential_url" | "pem";

const BASE58_LONG = /(?:^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{80,90}(?:$|[^1-9A-HJ-NP-Za-km-z])/;
const HEX_KEY = /(?:^|[^0-9a-fA-F])(?:0x)?(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})(?:$|[^0-9a-fA-F])/;
const BYTE_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){31,}\d{1,3}\s*\]/;
const API_KEY = /(?:^|[^A-Za-z0-9])(?:sk-(?:ant-|or-|proj-)?[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,})/;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/]*(?::[^\s/@]*)?@|\b(?:https?|wss?):\/\/\S*[?&](?:api[-_]?key|key|token|auth|secret|access[-_]?token)=/i;
const PEM = /-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET)-----/;
/** RPC providers carry the access token in the URL path (QuickNode /<token>/, Triton /<uuid>, Alchemy /v2/<key>). A URL on
 * a known RPC host with any long path segment, or any URL whose path has a UUID or a long random-looking token that is not
 * a Solana address or signature (so explorer, token-page and docs links still pass), is treated as a credential URL. */
const RPC_HOSTS = /(?:^|\.)(?:quiknode\.pro|rpcpool\.com|alchemy\.com|helius-rpc\.com|ankr\.com|chainstack\.com|getblock\.io|drpc\.org|syndica\.io|extrnode\.com|blastapi\.io|nodereal\.io|infura\.io|shyft\.to|triton\.one)$/i;
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$|^[1-9A-HJ-NP-Za-km-z]{86,88}$/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A long random-looking path segment (many digits and letters), not a readable slug and not a Solana address or signature. */
function tokenLike(segment: string): boolean {
  return /^[A-Za-z0-9_-]{24,}$/.test(segment) && !BASE58_ID.test(segment)
    && (segment.match(/[0-9]/g)?.length ?? 0) >= 4 && (segment.match(/[A-Za-z]/g)?.length ?? 0) >= 4;
}
function pathTokenUrl(text: string): boolean {
  for (const match of text.matchAll(/\b(?:https?|wss?):\/\/([^\s/?#]+)(\/[^\s?#]*)?/gi)) {
    const host = (match[1] ?? "").replace(/^[^@]*@/, "").replace(/:\d+$/, "").toLowerCase();
    const segments = (match[2] ?? "").split("/").filter(Boolean);
    if (RPC_HOSTS.test(host) && segments.some((segment) => segment.length >= 16)) return true;
    if (segments.some((segment) => UUID_SEGMENT.test(segment) || tokenLike(segment))) return true;
  }
  return false;
}

/** A message, a line or a sentence that is (after an optional "label:" and numbering such as "1." or "1)") only a 12, 15,
 * 18, 21 or 24 word list of short lowercase words, with optional commas: the shape of a recovery phrase. An ordinary
 * sentence has other words or another length and is not flagged. */
function seedPhrase(text: string): boolean {
  const parts = [text, ...text.split(/\n|(?<=[.!?])\s+/)];
  return parts.some((part) => {
    const body = part.replace(/^[^:\n]{0,40}:\s*/, "").replace(/\b\d{1,2}[.)]\s*/g, " ").replace(/[,.;!?"'`]+/g, " ");
    const words = body.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return [12, 15, 18, 21, 24].includes(words.length) && words.every((word) => /^[a-z]{3,8}$/.test(word));
  });
}

export function privateSecretKind(text: string): PrivateSecretKind | null {
  if (PEM.test(text)) return "pem";
  // Public identifiers that share a key's shape are set aside first: chat-drafted rule IDs (chat-rule-<sha256>), rule
  // revision IDs (brr_<hex>), sha256: digests, and links (an explorer link carries a signature or a hash, never a key;
  // credential links are checked separately below). A bare 0x + 64 hex string stays refused: an EVM transaction hash and an
  // EVM private key cannot be told apart, and neither can a bare 88-character base58 signature and a Solana secret key.
  const shapes = text.replace(/\bchat-rule-[0-9a-f]{64}\b|\bbrr_[0-9a-f]{64}\b|\bsha256:[0-9a-f]{64}\b|\b(?:https?|wss?):\/\/\S+/gi, " ");
  if (BASE58_LONG.test(shapes) || HEX_KEY.test(shapes) || BYTE_ARRAY.test(shapes)) return "private_key";
  if (API_KEY.test(text)) return "api_key";
  if (CREDENTIAL_URL.test(text) || pathTokenUrl(text)) return "credential_url";
  if (seedPhrase(text)) return "seed_phrase";
  return null;
}

export function privateSecretRefusal(kind: PrivateSecretKind): string {
  const what = { private_key: "a private key", seed_phrase: "a recovery phrase", api_key: "an API key", credential_url: "a URL with a password or key",
    pem: "a private key file" }[kind];
  return `That looks like ${what}, so it was not sent to the AI model. Secrets go only into the masked fields `
    + "(wallet passphrase, key import, API key, RPC URL). Remove it and send your message again.";
}
