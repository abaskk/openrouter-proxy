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
    visionPrompt: [
      "Respond in English only.",
      "",
      "For every image, do these in order:",
      "1. Transcribe all visible text exactly as shown - errors, stack traces, logs, code, labels. Preserve formatting, line numbers, paths.",
      "2. Describe the visual context: what tool/environment/UI is shown.",
      "3. If this is a UI screenshot: call out every visual anomaly with spatial precision - misaligned or off-center elements, broken layouts, malformed components, overflow/clipping, inconsistent spacing or colors. Say what looks like a bug vs intentional design. Be specific: \"submit button is ~10px right of center\", \"dropdown clips below the fold\".",
    ].join("\n"),
    visionMaxTokens: 1024,
    visionTimeoutMs: 60_000,
    onFailure: "placeholder" as "placeholder" | "error" | "passthrough",
    apiKey: process.env["CLAUDE_OPENROUTER_AUTH_TOKEN"] ?? "",
  },
  cache: {
    maxEntries: 200,
    ttlMs: 30 * 60 * 1000, // 30 minutes
  },
  limits: {
    maxConcurrentRequests: 12,
    maxQueuedRequests: 50,
    maxBodyBytes: 10 * 1024 * 1024, // 10MB
  },
  agent: {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 50,
    maxFreeSockets: 10,
    timeout: 120_000,
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
