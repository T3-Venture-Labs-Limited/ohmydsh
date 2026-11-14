import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Master switch for the socket bridge. Off by default: enable it only if you run the Qt HUD (see README, "Trust boundary"). */
  enabled: boolean
  /** Let the HUD prompt or create sessions whose permission mode is danger-full-access. Off by default (see README, "Trust boundary"). */
  allowDangerousSessions: boolean
  /** Socket path override; empty = `$XDG_RUNTIME_DIR/dsh-hud-<hash of DSH_HOME>.sock`. */
  socketPath: string
  /** Workspace (id or absolute path) that new HUD chats join; empty = the profile's default workspace. */
  workspace: string
  /** Model for new HUD chats. The provider is looked up in the catalog when left empty. */
  model: string
  provider: string
  /** Reasoning effort for new HUD chats; empty = the model's default. */
  effort: string
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(false),
  allowDangerousSessions: Schema.boolean().default(false),
  socketPath: Schema.string().default(''),
  workspace: Schema.string().default(''),
  model: Schema.string().default('claude-haiku-5-5'),
  provider: Schema.string().default(''),
  effort: Schema.string().default('low'),
}) as Schema<Config>
