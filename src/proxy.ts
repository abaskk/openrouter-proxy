import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { CONFIG } from "./config.js";
import { buildProxyHeaders } from "./headers.js";
import { log, CLR } from "./logger.js";
import { isSSEResponse, isStreamingRequest, createVSCodeSSEFixer, createSSELogger } from "./sse.js";
import { isDeniedModel, interceptImages } from "./interceptors/image.js";
import type { ChatRequest } from "./types.js";

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

async function processBody(
  raw: string,
  headers: http.IncomingHttpHeaders,
): Promise<string> {
  let body = raw;
  try {
    const obj = JSON.parse(raw) as ChatRequest;
    if (obj.messages) {
      splitMixedMessages(obj.messages);
    }
    if (obj.model && isDeniedModel(obj.model)) {
      await interceptImages(obj, headers.authorization);
    }
    body = JSON.stringify(obj);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Vision model failed")) {
      throw err;
    }
    // Non-JSON bodies pass through unmodified
  }
  return body;
}

function proxyRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse): void {
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

  const options = {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: clientReq.method,
    headers,
    rejectUnauthorized: CONFIG.ssl.rejectUnauthorized,
  } as http.RequestOptions;

  if (CONFIG.verbose) {
    const tag = wantSSE ? `${CLR.magenta}[SSE]${CLR.reset} ` : "";
    const ua = isClaudeVSCode ? `${CLR.yellow}[vscode]${CLR.reset} ` : "";
    log("proxy", `${tag}${ua}${clientReq.method} ${CLR.cyan}${targetUrl.hostname}${CLR.reset}${targetUrl.pathname}${targetUrl.search}`);
  }

  const proxyReq = proto.request(options, (proxyRes) => {
    const sse = isSSEResponse(proxyRes.headers as Record<string, string>);
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

    proxyRes.on("end", () => {
      if (CONFIG.verbose) {
        log("info", `Response complete - ${proxyRes.statusCode} ${clientReq.method} ${targetUrl.pathname}`);
      }
    });

    proxyRes.on("error", (err) => {
      log("error", `Upstream response error: ${err.message}`);
      if (!clientRes.headersSent) clientRes.writeHead(502, { "Content-Type": "text/plain" });
      clientRes.end("Bad Gateway: upstream response error");
    });
  });

  const chunks: Buffer[] = [];
  clientReq.on("data", (chunk) => chunks.push(chunk));
  clientReq.on("end", async () => {
    const raw = Buffer.concat(chunks).toString();
    let body: string;
    try {
      body = await processBody(raw, clientReq.headers);
    } catch (err) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "Content-Type": "text/plain" });
      }
      clientRes.end(`Bad Gateway: ${err instanceof Error ? err.message : "vision model error"}`);
      proxyReq.destroy();
      return;
    }
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
  ${CLR.dim}Test: curl http://localhost:${port}${CLR.reset}
`);
  });

  const shutdown = () => {
    log("info", "Shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}
