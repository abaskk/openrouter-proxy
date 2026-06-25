export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [key: string]: unknown };

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
  [key: string]: unknown;
}

export interface VisionApiResponse {
  id: string;
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  error?: { message: string; code: number };
}
