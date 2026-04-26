import type { StatusData } from "./types.js";

export type SessionTone = "brand" | "live" | "warning" | "danger";

export function getSessionBadge(status: StatusData): { label: string; tone: SessionTone } {
  if (status.sseConnected) {
    return { label: "LIVE", tone: "live" };
  }

  if (status.status === "setup-required") {
    return { label: "SETUP", tone: "warning" };
  }

  if (status.status === "chat-ready") {
    return { label: "CHAT READY", tone: "brand" };
  }

  if (status.status.includes("error")) {
    return { label: "ERROR", tone: "danger" };
  }

  return { label: "CONNECTING", tone: "warning" };
}
