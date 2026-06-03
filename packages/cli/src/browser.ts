import { spawn } from "node:child_process";

export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

function isAllowedBrowserUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function buildBrowserOpenCommand(rawUrl: string, platform = process.platform): BrowserOpenCommand {
  const url = new URL(rawUrl);
  if (!isAllowedBrowserUrl(url)) {
    throw new Error("Browser URL must use https or localhost http");
  }

  if (platform === "darwin") {
    return { command: "open", args: [url.toString()] };
  }
  if (platform === "win32") {
    return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url.toString()] };
  }
  return { command: "xdg-open", args: [url.toString()] };
}

export function openBrowser(url: string): void {
  try {
    const { command, args } = buildBrowserOpenCommand(url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.unref();
  } catch {
    // Browser launch is a convenience; callers also print the URL.
  }
}
