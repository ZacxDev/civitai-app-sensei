export interface Message {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
  /**
   * Set when the host's output scan withheld this reply. The content is then the
   * host's user-facing reason, not model output — render it as a policy notice
   * rather than as an assistant turn.
   */
  withheld?: boolean;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Session {
  id: string;
  title: string;
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionWithMessages extends Session {
  messages: Message[];
}

export interface AppSettings {
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  model: 'deepseek/deepseek-chat',
  temperature: 0.7,
  maxTokens: 2048,
  systemPrompt: `You are Civitai Sensei, an AI research assistant specializing in AI art and image generation. You can search the Civitai model catalog, look up model details, and find example images. Be helpful, concise, and knowledgeable about Stable Diffusion, LoRAs, checkpoints, and related tools.`,
};
