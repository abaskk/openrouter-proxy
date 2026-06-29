import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { CONFIG } from "./config.js";
import { buildProxyHeaders } from "./headers.js";
import { log, CLR } from "./logger.js";
import { isSSEResponse, isStreamingRequest, createVSCodeSSEFixer, createSSELogger } from "./sse.js";
import { isDeniedModel, interceptImages, getImageCacheSize } from "./interceptors/image.js";
import type { ChatRequest } from "./types.js";

// --- Shared HTTPS agent with keepalive ---
export const upstreamAgent = new https.Agent({
  keepAlive: CONFIG.agent.keepAlive,
  keepAliveMsecs: CONFIG.agent.keepAliveMsecs,
  maxSockets: CONFIG.agent.maxSockets,
  maxFreeSockets: CONFIG.agent.maxFreeSockets,
  timeout: CONFIG.agent.timeout,
  rejectUnauthorized: CONFIG.ssl.rejectUnauthorized,
});

// --- Request concurrency limiter ---
let activeRequests = 0;
const pendingQueue: Array<{ resolve: () => void }> = [];

function acquireSlot(): Promise<void> {
  if (activeRequests < CONFIG.limits.maxConcurrentRequests) {
    activeRequests++;
    return Promise.resolve();
  }
  if (pendingQueue.length >= CONFIG.limits.maxQueuedRequests) {
    throw new Error("Proxy overloaded - too many concurrent requests");
  }
  log("warn", `Request queued (${pendingQueue.length + 1} waiting)`);
  return new Promise(resolve => pendingQueue.push({ resolve }));
}

function releaseSlot(): void {
  if (pendingQueue.length > 0) {
    const next = pendingQueue.shift()!;
    next.resolve();
  } else {
    activeRequests--;
  }
}

// --- Fast check for image interception (no JSON parse) ---

function needsImageInterception(raw: string): boolean {
  if (!raw.includes('"type":"image"')) return false;
  const modelIdx = raw.indexOf('"model"');
  if (modelIdx === -1) return false;
  const match = raw.slice(modelIdx + 7).match(/^\s*:\s*"([^"]+)"/);
  return match ? isDeniedModel(match[1]) : false;
}

// --- Body processing with fast-path ---
function splitMixedMessages(messages: ChatRequest["messages"]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue;
    const toolBlocks = msg.content.filter(b => b.type === "tool_result");
    const otherBlocks = msg.content.filter(b => b.type !== "tool_result");
    if (toolBlocks.length > 0 && otherBlocks.length > 0) {
      msg.content = toolBlocks;
      messages.splice(i + 1, 0, { role: "user", content: otherBlocks });
    }
  }
}

async function processBody(raw: string, headers: http.IncomingHttpHeaders): Promise<string> {
  const modelIdx = raw.indexOf('"model"');
  if (modelIdx === -1) return raw;

  let obj: ChatRequest;
  try {
    obj = JSON.parse(raw) as ChatRequest;
  } catch {
    return raw;
  }

  if (obj.messages) splitMixedMessages(obj.messages);

  if (obj.model && isDeniedModel(obj.model)) {
    await interceptImages(obj, headers.authorization);
    return JSON.stringify(obj);
  }

  return raw;
}

// --- Active connection tracking for graceful shutdown ---
let activeConns = 0;

function trackConnection(res: http.ServerResponse): void {
  activeConns++;
  res.on("finish", () => activeConns--);
  res.on("close", () => activeConns--);
}

// --- Health check endpoint ---
function handleHealth(clientRes: http.ServerResponse): void {
  clientRes.writeHead(200, { "Content-Type": "application/json" });
  clientRes.end(JSON.stringify({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    activeRequests,
    queuedRequests: pendingQueue.length,
    activeConns,
    imageCacheSize: getImageCacheSize(),
    upstreamAgent: {
      sockets: (upstreamAgent as unknown as { sockets: Record<string, unknown> }).sockets
        ? Object.keys((upstreamAgent as unknown as { sockets: Record<string, unknown> }).sockets).length : 0,
      freeSockets: (upstreamAgent as unknown as { freeSockets: Record<string, unknown> }).freeSockets
        ? Object.keys((upstreamAgent as unknown as { freeSockets: Record<string, unknown> }).freeSockets).length : 0,
    },
  }));
}

// --- Main proxy handler ---
function proxyRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
  // Health check bypasses all proxying
  if (clientReq.url === "/_health" && clientReq.method === "GET") {
    handleHealth(clientRes);
    return;
  }

  // Acquire concurrency slot (rejects immediately if queue is full)
  let slotHeld = false;
  acquireSlot().then(() => { slotHeld = true; doProxy(); }).catch(() => {
    clientRes.writeHead(503, { "Content-Type": "text/plain" });
    clientRes.end("Proxy overloaded - too many concurrent requests");
  });

  function doProxy(): void {
    trackConnection(clientRes);

    const { protocol: tgtProto, hostname, port } = CONFIG.target;
    const targetUrl = new URL(clientReq.url!, `${tgtProto}//${hostname}`);
    if (port) targetUrl.port = port;

    if (targetUrl.pathname.startsWith("/v1/") || targetUrl.pathname === "/v1") {
      targetUrl.pathname = "/api" + targetUrl.pathname;
    }

    const headers = buildProxyHeaders(clientReq.headers as Record<string, string | string[] | undefined>);
    headers["host"] = hostname + (port ? `:${port}` : "");
    headers["x-forwarded-for"] = clientReq.socket.remoteAddress || "unknown";
    headers["x-forwarded-host"] = clientReq.headers.host || "";
    headers["x-forwarded-proto"] = "http";

    const isClaudeVSCode = CONFIG.sseFixUserAgents.some(ua => (clientReq.headers["user-agent"] || "").includes(ua));
    const wantSSE = isStreamingRequest(clientReq.headers);
    const proto = targetUrl.protocol === "https:" ? https : http;

    // SSE keepalive state (prevents client timeout during vision processing)
    let sentEarlyHeaders = false;
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

    function startKeepalive(): void {
      if (sentEarlyHeaders || !wantSSE) return;
      sentEarlyHeaders = true;
      clientRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      keepaliveTimer = setInterval(() => {
        try { clientRes.write(": keepalive\n\n"); } catch { /* client disconnected */ }
      }, 5000);
      log("image", "SSE keepalive started (vision processing in progress)");
    }

    function stopKeepalive(): void {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
    }

    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: clientReq.method,
      headers,
      agent: upstreamAgent,
    };

    if (CONFIG.verbose) {
      const tag = wantSSE ? `${CLR.magenta}[SSE]${CLR.reset} ` : "";
      const ua = isClaudeVSCode ? `${CLR.yellow}[vscode]${CLR.reset} ` : "";
      log("proxy", `${tag}${ua}${clientReq.method} ${CLR.cyan}${targetUrl.hostname}${CLR.reset}${targetUrl.pathname}${targetUrl.search}`);
    }

    const proxyReq = proto.request(options, (proxyRes) => {
      stopKeepalive();

      const sse = isSSEResponse(proxyRes.headers as Record<string, string>);

      if (sentEarlyHeaders) {
        // Already sent 200 + SSE headers via keepalive - forward body only, skip upstream headers
        if (proxyRes.statusCode && proxyRes.statusCode >= 400) {
          const errMsg = `Upstream error ${proxyRes.statusCode}`;
          log("error", errMsg);
          try {
            clientRes.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } })}\n\n`);
          } catch { /* client disconnected */ }
          clientRes.end();
          return;
        }

        if (sse && isClaudeVSCode) {
          const fixer = createVSCodeSSEFixer(clientRes);
          proxyRes.on("data", fixer.processChunk);
          proxyRes.on("end", fixer.finish);
        } else if (sse) {
          proxyRes.pipe(createSSELogger()).pipe(clientRes);
        } else {
          // Non-SSE upstream response but client expects SSE - pipe raw body
          proxyRes.on("data", (chunk: Buffer) => {
            try { clientRes.write(chunk); } catch { /* client disconnected */ }
          });
        }
      } else {
        // Normal flow - forward upstream headers + body
        const resHeaders: Record<string, string> = { ...proxyRes.headers } as Record<string, string>;

        if (sse) {
          delete resHeaders["content-length"];
          delete resHeaders["content-encoding"];
          delete resHeaders["cache-control"];
          resHeaders["cache-control"] = "no-cache, no-transform";
          resHeaders["connection"] = "keep-alive";
          resHeaders["x-accel-buffering"] = "no";
          if (CONFIG.verbose) log("sse", `SSE stream opened - ${proxyRes.statusCode}`);
        }

        clientRes.writeHead(proxyRes.statusCode!, proxyRes.statusMessage, resHeaders);

        if (sse && isClaudeVSCode) {
          const fixer = createVSCodeSSEFixer(clientRes);
          proxyRes.on("data", fixer.processChunk);
          proxyRes.on("end", fixer.finish);
        } else if (sse) {
          proxyRes.pipe(createSSELogger()).pipe(clientRes);
        } else {
          proxyRes.pipe(clientRes);
        }
      }

      proxyRes.on("end", () => {
        if (CONFIG.verbose) {
          log("info", `Response complete - ${proxyRes.statusCode} ${clientReq.method} ${targetUrl.pathname}`);
        }
      });

      proxyRes.on("error", (err) => {
        log("error", `Upstream response error: ${err.message}`);
        if (sentEarlyHeaders) {
          try {
            clientRes.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } })}\n\n`);
            clientRes.end();
          } catch { /* client disconnected */ }
        } else {
          if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "text/plain" });
          clientRes.end("Bad Gateway: upstream response error");
        }
      });
    });

    // Collect request body with size guard
    const chunks: Buffer[] = [];
    let bodySize = 0;
    let bodyTooLarge = false;

    clientReq.on("data", (chunk) => {
      bodySize += chunk.length;
      if (bodySize > CONFIG.limits.maxBodyBytes) {
        bodyTooLarge = true;
        log("error", `Request body too large: ${bodySize} bytes (limit: ${CONFIG.limits.maxBodyBytes})`);
        proxyReq.destroy();
        if (!clientRes.headersSent) clientRes.writeHead(413, { "Content-Type": "text/plain" });
        clientRes.end("Payload too large");
        clientReq.destroy();
        return;
      }
      chunks.push(chunk);
    });

    clientReq.on("end", async () => {
      if (bodyTooLarge) return;

      const raw = Buffer.concat(chunks).toString();

      // Start SSE keepalive if this request needs image interception
      if (wantSSE && needsImageInterception(raw)) {
        startKeepalive();
      }

      let body: string;
      try {
        body = await processBody(raw, clientReq.headers);
      } catch (err) {
        stopKeepalive();
        const errMsg = err instanceof Error ? err.message : "vision model error";
        if (sentEarlyHeaders) {
          log("error", `Vision error (SSE keepalive active): ${errMsg}`);
          try {
            clientRes.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } })}\n\n`);
            clientRes.end();
          } catch { /* client disconnected */ }
        } else {
          if (!clientRes.headersSent) {
            clientRes.writeHead(502, { "Content-Type": "text/plain" });
          }
          clientRes.end(`Bad Gateway: ${errMsg}`);
        }
        proxyReq.destroy();
        return;
      }

      stopKeepalive();
      proxyReq.setHeader("Content-Length", Buffer.byteLength(body));
      proxyReq.write(body);
      proxyReq.end();
    });

    clientReq.on("error", (err) => {
      log("error", `Client request error: ${err.message}`);
      proxyReq.destroy();
    });

    proxyReq.on("error", (err) => {
      log("error", `Upstream request error: ${err.message}`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end(`Bad Gateway: ${err.message}`);
    });

    proxyReq.setTimeout(wantSSE ? 0 : 60_000, () => {
      log("warn", "Upstream request timeout");
      proxyReq.destroy();
    });

    // Release concurrency slot when the upstream connection closes
    const release = () => { if (slotHeld) { releaseSlot(); slotHeld = false; } };
    clientRes.on("finish", release);
    clientRes.on("close", release);
  }
}

function proxyWebSocket(
  clientReq: http.IncomingMessage,
  clientSocket: import("node:net").Socket,
  clientHead: Buffer,
): void {
  const { hostname, port } = CONFIG.target;
  const targetUrl = new URL(clientReq.url!, `ws://${hostname}`);
  if (port) targetUrl.port = port;

  const headers = buildProxyHeaders(clientReq.headers as Record<string, string | string[] | undefined>);
  headers["host"] = hostname + (port ? `:${port}` : "");

  const proto = targetUrl.protocol === "wss:" ? https : http;

  const proxyReq = proto.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "wss:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: "GET",
    agent: upstreamAgent,
    headers: {
      ...headers,
      upgrade: "websocket",
      connection: "Upgrade",
      "sec-websocket-key": clientReq.headers["sec-websocket-key"] || "",
      "sec-websocket-version": clientReq.headers["sec-websocket-version"] || "13",
      "sec-websocket-extensions": clientReq.headers["sec-websocket-extensions"] || "",
    },
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket) => {
    if (CONFIG.verbose) log("ws", `WebSocket connected -> ${targetUrl.hostname}${targetUrl.pathname}`);

    clientSocket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
      "\r\n\r\n",
    );

    if (clientHead?.length) proxySocket.write(clientHead);
    proxySocket.pipe(clientSocket);
    clientSocket.pipe(proxySocket);
    proxySocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    log("error", `WebSocket proxy error: ${err.message}`);
    clientSocket.end();
  });

  proxyReq.end();
}

export function startServer(): http.Server {
  const server = http.createServer((req, res) => proxyRequest(req, res));

  server.on("upgrade", (req, socket, head) => {
    if (req.headers.upgrade?.toLowerCase() === "websocket") {
      proxyWebSocket(req, socket as import("node:net").Socket, head);
    } else {
      socket.end();
    }
  });

  server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  const { host, port } = CONFIG.listen;
  server.listen(port, host, () => {
    const target = `${CONFIG.target.protocol}//${CONFIG.target.hostname}`;
    console.log(`
${CLR.cyan}OpenRouter Proxy${CLR.reset}
  ${CLR.green}*${CLR.reset} Listening:  ${CLR.yellow}http://${host}:${port}${CLR.reset}
  ${CLR.green}*${CLR.reset} Target:     ${CLR.cyan}${target}${CLR.reset}
  ${CLR.green}*${CLR.reset} Vision:     ${CLR.yellow}${CONFIG.image.visionModel}${CLR.reset} (intercepting for: ${CONFIG.image.denyModels.join(", ")})
  ${CLR.green}*${CLR.reset} Limits:     ${CLR.dim}max ${CONFIG.limits.maxConcurrentRequests} concurrent, ${CONFIG.limits.maxQueuedRequests} queued, ${CONFIG.limits.maxBodyBytes / 1024 / 1024}MB body${CLR.reset}
  ${CLR.dim}Test: curl http://localhost:${port}/_health${CLR.reset}
`);
  });

  // Crash recovery
  process.on("uncaughtException", (err) => {
    log("error", `Uncaught exception: ${err.message}`);
    process.exit(1);
  });

  // Graceful shutdown with connection draining
  const shutdown = () => {
    log("info", `Shutting down - draining ${activeConns} active connection(s)...`);
    server.close(() => {
      log("info", "All connections drained");
      upstreamAgent.destroy();
      process.exit(0);
    });
    setTimeout(() => {
      log("warn", "Force closing remaining connections");
      server.closeAllConnections();
      setTimeout(() => process.exit(1), 2000);
    }, 28_000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
