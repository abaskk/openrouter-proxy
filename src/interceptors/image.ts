import { CONFIG } from "../config.js";
import { log, CLR } from "../logger.js";
import type { ChatRequest, ContentBlock, ImageBlock, TextBlock, VisionApiResponse } from "../types.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

export function isDeniedModel(model: string): boolean {
  return CONFIG.image.denyModels.some(denied => model === denied);
}

interface ImageLocation {
  messageIndex: number;
  blockIndex: number;
  block: ImageBlock;
}

function findImageBlocks(request: ChatRequest): ImageLocation[] {
  const locations: ImageLocation[] = [];
  for (let mi = 0; mi < request.messages.length; mi++) {
    const msg = request.messages[mi];
    if (!Array.isArray(msg.content)) continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const block = msg.content[bi] as ContentBlock;
      if (block.type === "image") {
        locations.push({ messageIndex: mi, blockIndex: bi, block: block as ImageBlock });
      }
    }
  }
  return locations;
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

async function describeImage(block: ImageBlock, authHeader: string | undefined): Promise<string> {
  const apiKey = CONFIG.image.apiKey || extractBearerToken(authHeader);
  if (!apiKey) throw new Error("No OpenRouter API key - set CLAUDE_OPENROUTER_AUTH_TOKEN or pass Authorization header");

  const dataUrl = `data:${block.source.media_type};base64,${block.source.data}`;

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://claude.ai",
      "X-Title": "Claude Code",
    },
    body: JSON.stringify({
      model: CONFIG.image.visionModel,
      messages: [{
        role: "user" as const,
        content: [
          { type: "text" as const, text: CONFIG.image.visionPrompt },
          { type: "image_url" as const, image_url: { url: dataUrl } },
        ],
      }],
      max_tokens: CONFIG.image.visionMaxTokens,
    }),
    signal: AbortSignal.timeout(CONFIG.image.visionTimeoutMs),
  });

  const data = await response.json() as VisionApiResponse;

  if (!response.ok || data.error) {
    throw new Error(`Vision API error (${response.status}): ${data.error?.message ?? "unknown"}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Vision API returned empty response");

  return content;
}

export async function interceptImages(
  request: ChatRequest,
  authorizationHeader: string | undefined,
): Promise<void> {
  const imageLocations = findImageBlocks(request);
  if (imageLocations.length === 0) return;

  log("image", `Found ${imageLocations.length} image(s) in request to ${CLR.yellow}${request.model}${CLR.reset} - intercepting`);

  const results = await Promise.allSettled(
    imageLocations.map(loc => describeImage(loc.block, authorizationHeader)),
  );

  for (let i = imageLocations.length - 1; i >= 0; i--) {
    const loc = imageLocations[i];
    const result = results[i];

    let description: string;
    if (result.status === "fulfilled") {
      description = result.value;
      log("image", `Image ${i + 1}/${imageLocations.length}: described successfully`);
    } else {
      const err = result.reason instanceof Error ? result.reason.message : String(result.reason);
      log("error", `Image ${i + 1}/${imageLocations.length} vision call failed: ${err}`);

      switch (CONFIG.image.onFailure) {
        case "error":
          throw new Error(`Vision model failed for image: ${err}`);
        case "passthrough":
          continue;
        case "placeholder":
        default:
          description = "[Image: description unavailable]";
      }
    }

    const msg = request.messages[loc.messageIndex];
    if (Array.isArray(msg.content)) {
      (msg.content as ContentBlock[])[loc.blockIndex] = {
        type: "text",
        text: `[Image description]: ${description}`,
      } satisfies TextBlock;
    }
  }
}
