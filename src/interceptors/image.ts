import { createHash } from "node:crypto";
import https from "node:https";
import { CONFIG } from "../config.js";
import { log, CLR } from "../logger.js";
import type { ChatRequest, ContentBlock, ImageBlock, TextBlock, ToolResultBlock, VisionApiResponse } from "../types.js";
import { upstreamAgent } from "../proxy.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export function isDeniedModel(model: string): boolean {
  return CONFIG.image.denyModels.some(denied => model === denied);
}

// --- LRU image cache with TTL ---

const imageCache = new Map<string, { desc: string; expires: number }>();

function cacheGet(key: string): string | undefined {
  const entry = imageCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    imageCache.delete(key);
    return undefined;
  }
  // Move to end (LRU)
  imageCache.delete(key);
  imageCache.set(key, entry);
  return entry.desc;
}

function cacheSet(key: string, desc: string): void {
  if (imageCache.size >= CONFIG.cache.maxEntries) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined) imageCache.delete(oldest);
  }
  imageCache.set(key, { desc, expires: Date.now() + CONFIG.cache.ttlMs });
}

export function getImageCacheSize(): number {
  return imageCache.size;
}

// --- Recursive image discovery ---

interface ImageLocation {
  messageIndex: number;
  container: ContentBlock[];
  index: number;
  block: ImageBlock;
  hash: string;
}

function searchContentArray(
  container: ContentBlock[],
  messageIndex: number,
  locations: ImageLocation[],
): void {
  for (let i = 0; i < container.length; i++) {
    const block = container[i];
    if (block.type === "image") {
      locations.push({ messageIndex, container, index: i, block: block as ImageBlock, hash: "" });
    } else if (block.type === "tool_result") {
      const tr = block as ToolResultBlock;
      if (Array.isArray(tr.content)) {
        searchContentArray(tr.content as ContentBlock[], messageIndex, locations);
      }
    }
  }
}

function findImageBlocks(request: ChatRequest): ImageLocation[] {
  const locations: ImageLocation[] = [];
  for (let mi = 0; mi < request.messages.length; mi++) {
    const msg = request.messages[mi];
    if (!Array.isArray(msg.content)) continue;
    searchContentArray(msg.content as ContentBlock[], mi, locations);
  }
  // Pre-compute SHA-256 hashes once
  for (const loc of locations) {
    loc.hash = createHash("sha256").update(loc.block.source.data).digest("hex");
  }
  return locations;
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

// --- Vision API call with connection reuse ---

function describeImage(block: ImageBlock, authHeader: string | undefined): Promise<string> {
  const apiKey = CONFIG.image.apiKey || extractBearerToken(authHeader);
  if (!apiKey) return Promise.reject(new Error("No OpenRouter API key - set CLAUDE_OPENROUTER_AUTH_TOKEN or pass Authorization header"));

  const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;

  const payload = JSON.stringify({
    model: CONFIG.image.visionModel,
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: CONFIG.image.visionPrompt },
        { type: "image_url" as const, image_url: { url: dataUrl } },
      ],
    }],
    max_tokens: CONFIG.image.visionMaxTokens,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(OPENROUTER_API_URL, {
      method: "POST",
      agent: upstreamAgent,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://claude.ai",
        "X-Title": "Claude Code",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try {
          const data = JSON.parse(body) as VisionApiResponse;
          if (!res.statusCode || res.statusCode >= 300 || data.error) {
            reject(new Error(`Vision API error (${res.statusCode}): ${data.error?.message ?? "unknown"}`));
            return;
          }
          const content = data.choices?.[0]?.message?.content;
          if (!content) { reject(new Error("Vision API returned empty response")); return; }
          resolve(content);
        } catch (err) {
          reject(new Error(`Vision API parse error: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
    });

    req.setTimeout(CONFIG.image.visionTimeoutMs, () => {
      req.destroy(new Error("Vision API timeout"));
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length) as PromiseSettledResult<T>[];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }

  const workerCount = Math.min(limit, tasks.length);
  const workers = [];
  for (let i = 0; i < workerCount; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export async function interceptImages(
  request: ChatRequest,
  authorizationHeader: string | undefined,
): Promise<void> {
  const imageLocations = findImageBlocks(request);
  if (imageLocations.length === 0) return;

  log("image", `Found ${imageLocations.length} image(s) in request to ${CLR.yellow}${request.model}${CLR.reset} - intercepting`);

  const descriptions: (string | null)[] = new Array(imageLocations.length).fill(null);
  const uncachedIndices: number[] = [];

  for (let i = 0; i < imageLocations.length; i++) {
    const loc = imageLocations[i];

    // Skip trivially small images (< 10KB decoded)
    const decodedBytes = Math.floor(loc.block.source.data.length * 0.75);
    if (decodedBytes < 10_240) {
      descriptions[i] = "[Image: too small to describe]";
      log("image", `Image ${i + 1}/${imageLocations.length}: skipped (too small, ${decodedBytes} bytes)`);
      continue;
    }

    const cached = cacheGet(loc.hash);
    if (cached) {
      descriptions[i] = cached;
      log("image", `Image ${i + 1}/${imageLocations.length}: cache hit`);
    } else {
      uncachedIndices.push(i);
    }
  }

  // Fetch uncached images with concurrency cap (blocks until all done)
  if (uncachedIndices.length > 0) {
    const tasks = uncachedIndices.map(i => () => describeImage(imageLocations[i].block, authorizationHeader));
    const results = await runWithConcurrency(tasks, 3);

    for (let j = 0; j < uncachedIndices.length; j++) {
      const i = uncachedIndices[j];
      const result = results[j];

      if (result.status === "fulfilled") {
        descriptions[i] = result.value;
        cacheSet(imageLocations[i].hash, result.value);
        log("image", `Image ${i + 1}/${imageLocations.length}: described successfully`);
      } else {
        const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
        log("error", `Image ${i + 1}/${imageLocations.length} vision call failed: ${err}`);

        switch (CONFIG.image.onFailure) {
          case "error":
            throw new Error(`Vision model failed for image: ${err}`);
          case "passthrough":
            break;
          case "placeholder":
          default:
            descriptions[i] = "[Image: description unavailable]";
        }
      }
    }
  }

  // Replace image blocks with text descriptions (iterate backwards for safe splice)
  for (let i = imageLocations.length - 1; i >= 0; i--) {
    const loc = imageLocations[i];
    const description = descriptions[i];
    if (description === null) continue;

    loc.container[loc.index] = {
      type: "text",
      text: `[Image description]: ${description}`,
    } satisfies TextBlock;
  }
}
