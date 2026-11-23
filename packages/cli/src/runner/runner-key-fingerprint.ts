/** The runner key fingerprint the pairing card and Hub's pairing page show (pairing-workflow.ts), and the A2a seal card compares: sha256
 * over the raw public key bytes, hex. Public: derived from a public key only. Leaf module (no runner imports). */
import { createHash } from "node:crypto";

export function runnerKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
}
