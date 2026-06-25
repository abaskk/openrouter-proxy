export const CONFIG = {
  listen: { host: "127.0.0.1", port: 8899 },
  target: { protocol: "https:" as const, hostname: "openrouter.ai", port: null as string | null },
  ssl: { rejectUnauthorized: true },
  verbose: true,
  sseFixUserAgents: ["claude-vscode"],
  image: {
    enabled: true,
    denyModels: ["xiaomi/mimo-v2.5-pro"],
    visionModel: "qwen/qwen3-vl-32b-instruct",
    visionPrompt: "Describe this image concisely. Focus on text, code, diagrams, and UI elements. Be specific and factual.",
    visionMaxTokens: 512,
    visionTimeoutMs: 30_000,
    onFailure: "placeholder" as "placeholder" | "error" | "passthrough",
    apiKey: process.env["CLAUDE_OPENROUTER_AUTH_TOKEN"] ?? "",
  },
};

export const HEADERS_OVERRIDE: Record<string, string> = {
  "HTTP-Referer": "https://claude.ai",
  "X-Title": "Claude Code",
};

export const HEADERS_REMOVE = new Set(["host", "x-forwarded-for"]);

export const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailers",
  "transfer-encoding", "upgrade",
]);
