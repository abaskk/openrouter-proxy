# OpenRouter Proxy

> A zero-dependency TypeScript proxy that unlocks **free Xiaomi MiMo** on OpenRouter for any client, fixes **SSE streaming** issues with VS Code Claude Code, and **intercepts images** for non-vision models by describing them via a vision model.

---

## What It Does

**Free MiMo for any tool** - [Xiaomi MiMo](https://openrouter.ai/xiaomi/mimo-v2-pro) is free on OpenRouter, but only through the **OpenClaw** channel. This proxy injects the right headers automatically - works with any HTTP client.

**Claude Code SSE fix** - VS Code's Claude Code extension breaks when consuming OpenRouter's SSE stream due to `redacted_thinking` errors, duplicate events, and missing content block boundaries. The proxy repairs these transparently.

**Image interception** - Non-vision models (MiMo, DeepSeek, etc.) can't process images. The proxy detects image blocks in requests to configured models, sends them to a vision model (Qwen3-VL-32B by default), and replaces them with text descriptions before forwarding.

```
┌──────────────────┐       ┌──────────────────────┐       ┌─────────────────┐
│   Any AI Tool    │──────▶│  OpenRouter Proxy    │──────▶│   OpenRouter    │
│                  │       │  localhost:8899       │       │                 │
│  Claude Code     │◀──────│                      │◀──────│  Xiaomi MiMo    │
│  Continue        │       │  • Inject headers    │       │  (free via      │
│  Cline / Aider   │       │  • Fix SSE streams   │       │   OpenClaw)     │
│  OpenAI SDK      │       │  • Intercept images  │       │                 │
│  Any HTTP client │       │  • Concurrency limit │       │                 │
└──────────────────┘       └──────────────────────┘       └─────────────────┘
```

| Feature | Detail |
|---------|--------|
| **Header injection** | Adds `HTTP-Referer` + `X-Title` to qualify for free MiMo - works with **any tool** |
| **SSE repair** | Filters `redacted_thinking`, injects missing `content_block_stop`, fixes event order - **Claude Code only** |
| **Image interception** | Replaces base64 images with text descriptions via vision model for non-vision targets |
| **Vision cache** | LRU cache with TTL (30min, 200 entries) - same image hash = cached description |
| **Concurrency limiter** | Max 12 concurrent requests, 50 queued, 10MB body limit |
| **SSE keepalive** | Sends `: keepalive` comments during vision processing to prevent client timeout |
| **Health check** | `GET /_health` returns proxy status, active connections, cache size |
| **WebSocket** | Full upgrade proxy support |
| **Graceful shutdown** | Connection draining on SIGINT/SIGTERM |

---

## Architecture

```
src/
  index.ts                 # Entry point - starts the server
  config.ts                # All configuration (listen, target, image, cache, limits)
  types.ts                 # TypeScript interfaces (ChatRequest, ContentBlock, etc.)
  proxy.ts                 # HTTP/WebSocket proxy, concurrency limiter, health check
  headers.ts               # Header building (strips hop-by-hop, applies overrides)
  sse.ts                   # SSE parsing, VS Code fixer, SSE logger transform
  logger.ts                # Colored logging with level icons
  interceptors/
    image.ts               # Image detection, vision model calls, LRU cache
```

### Request flow

```
Client request
  │
  ├─ /_health → respond with JSON status
  │
  ├─ WebSocket → proxy upgrade to OpenRouter
  │
  └─ HTTP
       │
       ├─ Fast-path check: does body contain images + denied model?
       │   ├─ No → forward to OpenRouter unchanged
       │   └─ Yes → parse body, split mixed messages
       │            ├─ Send SSE keepalive to client (prevents timeout)
       │            ├─ Extract image blocks, check cache by SHA-256
       │            ├─ Call vision model for uncached images (max 3 concurrent)
       │            ├─ Replace image blocks with text descriptions
       │            └─ Forward modified body to OpenRouter
       │
       └─ Response
            ├─ Claude VS Code → SSE fixer (filter redacted_thinking, fix block lifecycle)
            ├─ Other SSE → SSE logger transform (pass-through with logging)
            └─ Non-SSE → pipe directly
```

---

## Quick Start

```bash
git clone https://github.com/aaravarr/openrouter-proxy.git
cd openrouter-proxy
npm install
npm start
```

The proxy listens on **`http://127.0.0.1:8899`**. Point your tool's base URL there:

| Before | After |
|--------|-------|
| `https://openrouter.ai` | `http://127.0.0.1:8899` |

Everything else (API key, paths, request body) stays the same.

---

## Configuration

Edit [`src/config.ts`](./src/config.ts):

```ts
export const CONFIG = {
  listen: { host: "127.0.0.1", port: 8899 },
  target: { protocol: "https:", hostname: "openrouter.ai", port: null },
  ssl: { rejectUnauthorized: true },
  verbose: true,
  sseFixUserAgents: ["claude-vscode"],
  image: {
    enabled: true,
    denyModels: ["xiaomi/mimo-v2.5-pro", "deepseek/deepseek-v4-pro"],
    visionModel: "qwen/qwen3-vl-32b-instruct",
    visionPrompt: "...",
    visionMaxTokens: 1024,
    visionTimeoutMs: 60_000,
    onFailure: "placeholder",  // "placeholder" | "error" | "passthrough"
    apiKey: process.env["CLAUDE_OPENROUTER_AUTH_TOKEN"] ?? "",
  },
  cache: {
    maxEntries: 200,
    ttlMs: 30 * 60 * 1000,
  },
  limits: {
    maxConcurrentRequests: 12,
    maxQueuedRequests: 50,
    maxBodyBytes: 10 * 1024 * 1024,
  },
  agent: {
    keepAlive: true,
    timeout: 120_000,
  },
};
```

| Key | Default | Description |
|-----|---------|-------------|
| `listen.host` | `127.0.0.1` | Bind address (`0.0.0.0` for LAN) |
| `listen.port` | `8899` | Listen port |
| `target.hostname` | `openrouter.ai` | Upstream host |
| `verbose` | `true` | Log every request and SSE event |
| `sseFixUserAgents` | `["claude-vscode"]` | User agents that trigger SSE repair |
| `image.denyModels` | MiMo, DeepSeek | Models that get image interception |
| `image.visionModel` | `qwen/qwen3-vl-32b-instruct` | Vision model for image descriptions |
| `image.onFailure` | `"placeholder"` | What to do when vision call fails |
| `limits.maxConcurrentRequests` | `12` | Max simultaneous upstream requests |
| `limits.maxBodyBytes` | `10MB` | Request body size limit |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `CLAUDE_OPENROUTER_AUTH_TOKEN` | API key for vision model calls (falls back to request Authorization header) |

---

## Image Interception

When a request to a denied model contains image blocks:

1. Images are found recursively (including inside `tool_result` blocks)
2. Each image is SHA-256 hashed and checked against the LRU cache
3. Uncached images are sent to the vision model (max 3 concurrent)
4. Image blocks are replaced with `[Image description]: ...` text blocks
5. The modified request is forwarded to OpenRouter

The vision model receives a prompt that instructs it to:
- Transcribe all visible text exactly (errors, stack traces, code)
- Describe visual context (tool/environment/UI)
- Call out visual anomalies with spatial precision

**SSE keepalive**: During vision processing, the proxy sends `: keepalive` SSE comments every 5 seconds to prevent the client from timing out.

---

## SSE Compatibility Fixes

When using Claude Code in VS Code, OpenRouter translates model output into Anthropic-style streaming events. This causes compatibility issues. The proxy repairs:

| Problem | Fix |
|---------|-----|
| `redacted_thinking` content blocks | Filtered out entirely |
| Missing `content_block_stop` events | Injected at correct positions |
| Missing `signature_delta` for thinking blocks | Synthetic signature injected |
| Duplicate / late `message_stop` | Deduplicated and emitted last |

These fixes only apply to user agents matching `sseFixUserAgents` (default: `claude-vscode`). Other tools get the free MiMo access via header injection without SSE manipulation.

---

## Health Check

```bash
curl http://localhost:8899/_health
```

Returns:
```json
{
  "status": "ok",
  "uptime": 3600,
  "activeRequests": 2,
  "queuedRequests": 0,
  "activeConns": 3,
  "imageCacheSize": 15,
  "upstreamAgent": { "sockets": 2, "freeSockets": 1 }
}
```

---

## License

[MIT](./LICENSE)
