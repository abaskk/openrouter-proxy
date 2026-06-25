import type http from "node:http";
import { Transform } from "node:stream";
import { CONFIG } from "./config.js";
import { log, CLR } from "./logger.js";

export function isSSEResponse(headers: http.IncomingHttpHeaders): boolean {
  return (headers["content-type"] || "").includes("text/event-stream");
}

export function isStreamingRequest(headers: http.IncomingHttpHeaders): boolean {
  return (headers["accept"] || "").includes("text/event-stream");
}

interface SSEEvent {
  event: string;
  data: unknown;
}

export function parseSSEBlock(block: string): SSEEvent {
  let event = "";
  let data: unknown = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      try { data = JSON.parse(line.slice(5).trim()); } catch { /* ignore */ }
    } else if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
  }
  return { event, data };
}

function writeSSE(res: http.ServerResponse, eventData: string, tag: string): void {
  if (CONFIG.verbose) {
    const color = tag.includes("filter") ? CLR.red
                : tag.includes("insert") ? CLR.blue
                : CLR.dim;
    const preview = eventData.replace(/\n/g, " ").slice(0, 120);
    log("sse", `${color}${tag}:${CLR.reset} ${CLR.dim}${preview}${CLR.reset}`);
  }
  if (tag.includes("filter")) return;
  res.write(eventData + "\n\n");
}

function flushStopEvents(res: http.ServerResponse, indexes: number[]): void {
  for (const idx of indexes) {
    const evt = `event: content_block_stop\ndata: {"type":"content_block_stop","index":${idx}}`;
    writeSSE(res, evt, "insert");
  }
  indexes.length = 0;
}

export interface SSEFixer {
  processChunk: (chunk: Buffer) => void;
  finish: () => void;
}

export function createVSCodeSSEFixer(res: http.ServerResponse): SSEFixer {
  let buffer = "";
  let isThinking = false;
  let isRedactedThinking = false;
  const pendingIndexes: number[] = [];

  function processChunk(chunk: Buffer): void {
    buffer += chunk.toString();
    const events = buffer.split("\n\n");
    buffer = events.pop()!;

    for (const raw of events) {
      const { event, data } = parseSSEBlock(raw);

      if (raw.includes('"redacted_thinking"') || isRedactedThinking) {
        writeSSE(res, raw, "filter");
        isRedactedThinking = !isRedactedThinking;
        continue;
      }

      if (isThinking && !raw.includes('"thinking"')) {
        isThinking = false;
        const sig = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"dd9960d18582b741463f3ba1347853ee2ad01144306d9b1e07fd45808d81b171"}}';
        writeSSE(res, sig, "insert");
      }

      if (event === "content_block_start") {
        if (raw.includes('"thinking"')) isThinking = true;
        flushStopEvents(res, pendingIndexes);
        pendingIndexes.push((data as { index?: number })?.index ?? 0);
        writeSSE(res, raw, "data");
      } else if (event === "content_block_stop") {
        writeSSE(res, raw, "filter");
      } else if (event === "message_stop" || raw.trimEnd().endsWith("[DONE]")) {
        writeSSE(res, raw, "filter");
      } else {
        writeSSE(res, raw, "data");
      }
    }
  }

  function finish(): void {
    if (buffer.length > 0) res.write(buffer);
    flushStopEvents(res, pendingIndexes);
    writeSSE(res, `event: message_stop\ndata: {"type":"message_stop"}\n\n`, "insert");
    writeSSE(res, `event: data\ndata: [DONE]\n\n`, "insert");
    res.end();
  }

  return { processChunk, finish };
}

export function createSSELogger(): Transform {
  let buf = "";
  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString();
      const events = buf.split("\n\n");
      buf = events.pop()!;
      for (const raw of events) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const { event } = parseSSEBlock(raw);
        const tag = event || "data";
        const preview = trimmed.replace(/\n/g, " ").slice(0, 120);
        log("sse", `${CLR.dim}pipe:${CLR.reset} ${CLR.dim}${tag} ${preview}${CLR.reset}`);
      }
      this.push(chunk);
      cb();
    },
    flush(cb) {
      if (buf.trim()) {
        const { event } = parseSSEBlock(buf);
        log("sse", `${CLR.dim}pipe:${CLR.reset} ${CLR.dim}${event || "data"} ${buf.trim().replace(/\n/g, " ").slice(0, 120)}${CLR.reset}`);
      }
      cb();
    },
  });
}
