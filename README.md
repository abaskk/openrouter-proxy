# OpenRouter Proxy

> A local TypeScript proxy that makes non-Anthropic OpenRouter models work properly with Claude Code: fixes SSE streaming, intercepts and describes images for blind models, and injects client identification headers.

---

## Why

Claude Code in VS Code streams via Anthropic-format SSE events. OpenRouter's output for non-Anthropic models (MiMo, DeepSeek, GLM) doesn't match what Claude Code expects, causing `redacted_thinking` errors, dropped content blocks, and broken streams.

Additionally, models like MiMo and DeepSeek can't process images - but Claude Code sends them as screenshots during tool use. The proxy intercepts those images, has a vision model describe them, and forwards the description instead.

---

## Architecture

```
src/
  index.ts              — starts the server on :8899
  config.ts             — listen/target config, model lists, limits, headers
  proxy.ts              — HTTP/WebSocket handler, concurrency limiter, health check
  headers.ts            — strips hop-by-hop headers, applies client identification overrides
  sse.ts                — SSE parser, VS Code event fixer, SSE logger transform
  logger.ts             — colored structured logging (TTY-aware)
  types.ts              — ContentBlock, ChatRequest, VisionApiResponse interfaces
  interceptors/
    image.ts            — image detection (recursive into tool_results), SHA-256 hashing,
                          LRU cache, vision model calls with concurrency cap
```

### Request lifecycle

```
incoming request
  ├─ GET /_health          → status JSON
  ├─ WebSocket upgrade     → proxied to OpenRouter
  └─ POST /api/v1/messages
       │
       ├─ /v1/* path?      → rewrite to /api/v1/* (VS Code sends bare /v1 endpoints)
       │
       ├─ contains images + model in denyModels?
       │   ├─ no  → forward body unchanged
       │   └─ yes → parse body
       │            ├─ split mixed tool_result+content user messages (DeepSeek compat)
       │            ├─ start SSE keepalive (5s ping to prevent client timeout)
       │            ├─ find all image blocks (recursive: message content + tool_results)
       │            ├─ SHA-256 each → check 200-entry/30min LRU cache
       │            ├─ call vision model for uncached (max 3 concurrent, 60s timeout)
       │            ├─ replace image blocks with "[Image description]: ..." text
       │            └─ forward modified body
       │
       ├─ response is SSE + user-agent is claude-vscode?
       │   ├─ yes → SSE fixer pipeline:
       │   │         filter redacted_thinking blocks
       │   │         inject missing signature_delta after thinking blocks
       │   │         inject missing content_block_stop events at correct positions
       │   │         deduplicate message_stop, emit [DONE]
       │   └─ no  → pipe through with SSE logging
       │
       └─ concurrency: max 12 active, 50 queued, 10MB body limit
```

---

## Quick Start

```bash
git clone https://github.com/aaravarr/openrouter-proxy.git
cd openrouter-proxy
npm install
npm start
```

Point Claude Code's API base at `http://127.0.0.1:8899` - API key, paths, and body format stay the same:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8899",
    "ANTHROPIC_AUTH_TOKEN": "sk-or-v1-..."
  }
}
```

---

## Configuration

Edit `src/config.ts`:

### Target models

| Config | Default | Purpose |
|--------|---------|---------|
| `image.denyModels` | `["xiaomi/mimo-v2.5-pro", "deepseek/deepseek-v4-pro"]` | Models that get image interception |
| `image.visionModel` | `"qwen/qwen3-vl-32b-instruct"` | Model used to describe images |
| `image.visionMaxTokens` | `1024` | Max tokens for vision responses |
| `image.visionTimeoutMs` | `60000` | Vision call timeout |
| `image.onFailure` | `"placeholder"` | On vision failure: `"placeholder"` \| `"error"` \| `"passthrough"` |
| `sseFixUserAgents` | `["claude-vscode"]` | User agents that get SSE repair |

### Server

| Config | Default | Purpose |
|--------|---------|---------|
| `listen.host` / `listen.port` | `127.0.0.1:8899` | Where the proxy binds |
| `target.hostname` | `openrouter.ai` | Upstream |
| `limits.maxConcurrentRequests` | `12` | Max simultaneous upstream requests |
| `limits.maxQueuedRequests` | `50` | Max queue depth before 503 |
| `limits.maxBodyBytes` | `10MB` | Request body cap before 413 |
| `cache.maxEntries` | `200` | Image description LRU cache size |
| `cache.ttlMs` | `1800000` (30 min) | Cache entry lifetime |

### Headers

```ts
HEADERS_OVERRIDE = {
  "HTTP-Referer": "https://claude.ai",
  "X-Title": "Claude Code",
}
```

Injected into every upstream request so OpenRouter identifies the traffic as Claude Code.

### Environment

| Variable | Purpose |
|----------|---------|
| `CLAUDE_OPENROUTER_AUTH_TOKEN` | API key for vision model calls. Falls back to the incoming request's `Authorization` header if unset. |

---

## SSE Fixes

OpenRouter translates model output to Anthropic-format SSE events, but the conversion has gaps. The proxy repairs them for Claude VS Code:

| Problem | Root cause | Fix |
|---------|-----------|-----|
| `unsupported content type: redacted_thinking` | Some providers emit redacted thinking blocks that Claude Code doesn't recognize | Filtered out |
| Missing `content_block_stop` | OpenRouter doesn't emit stops for thinking blocks | Injected after each block at correct index |
| Missing `signature_delta` | Claude Code expects a signature after thinking | Synthetic signature injected |
| Duplicate `message_stop` | Multiple `message_stop` or `[DONE]` events arrive | Deduplicated, emitted once at end |

---

## Image Interception

When a request to a non-vision model contains images:

1. **Detect** - Fast string scan for `"type":"image"` in the request body. If the model is in `denyModels`, full parse and interception kicks in.

2. **Split** - If any user message mixes `tool_result` blocks with text/image blocks, split into separate messages (DeepSeek rejects mixed messages).

3. **Find** - Walk all messages recursively: top-level content blocks AND inside `tool_result` content arrays. Extract every image block.

4. **Cache check** - SHA-256 hash each image. Skip images under 10KB decoded. Check LRU cache for matching hashes.

5. **Describe** - Uncached images are sent to the vision model via OpenRouter with a prompt that asks for: text transcription (errors, code, paths), visual context (tool/UI/environment), and spatial anomaly detection (misaligned elements, clipping, broken layouts).

6. **Replace** - Original image blocks are replaced with `[Image description]: <vision model output>` text blocks. Cached for 30 minutes.

7. **SSE keepalive** - While the vision model processes (can take 1-30s), the proxy sends `: keepalive\n\n` every 5 seconds so the client doesn't drop the connection.

---

## Health Check

```bash
curl http://localhost:8899/_health
```

---

## License

[MIT](./LICENSE)