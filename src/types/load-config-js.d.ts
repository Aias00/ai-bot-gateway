declare module "*config/loadConfig.js" {
  export interface LoadedChannelSetup {
    cwd: string;
    model?: string;
    agentId?: string;
  }

  export interface AgentConfig {
    model?: string;
    enabled?: boolean;
    runtime?: "codex" | "claude";
    capabilities?: Record<string, boolean>;
    meta?: Record<string, unknown>;
  }

  export interface LoadedConfig {
    channels: Record<string, LoadedChannelSetup>;
    agents: Record<string, AgentConfig>;
    defaultAgent: string | null;
    defaultModel: string;
    defaultEffort: string;
    approvalPolicy: string;
    sandboxMode: string;
    runtime: "codex" | "claude";
    allowedUserIds: string[];
    allowedFeishuUserIds: string[];
    autoDiscoverProjects: boolean;
  }

  export function loadConfig(
    filePath: string,
    options?: { defaultModel?: string; defaultEffort?: string }
  ): Promise<LoadedConfig>;
}
