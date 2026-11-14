import z from '@deepseek-ai/schemastery'

/** Plugin configuration (cordis.patch.yml `config:`). */
export interface Config {
  /** Interpreter used when a notebook pins none and no project environment is found. */
  python?: string
  /** Write edits and outputs to disk shortly after every change. */
  autosave?: boolean
  /** Per-cell cap on stored stream text, in characters (the file keeps up to this much). */
  maxOutputChars?: number
  /** Time limit for one cell run by the agent, in seconds (0 = none). */
  agentCellTimeoutS?: number
  /** Stop a kernel after this many minutes with no open view and no running cell (0 = never). */
  idleMinutes?: number
  /** `auto` asks for approval whenever the session sandbox is not full access; `always` always asks; `never` never asks. */
  approval?: 'auto' | 'always' | 'never'
}

export const Config: z<Config> = z.object({
  python: z.string(),
  autosave: z.boolean().default(true),
  maxOutputChars: z.number().step(1).min(1000).default(200_000),
  agentCellTimeoutS: z.number().step(1).min(0).default(120),
  idleMinutes: z.number().step(1).min(0).default(30),
  approval: z.union(['auto', 'always', 'never'] as const).default('auto'),
}) as unknown as z<Config>

export interface Settings {
  python: string | undefined
  autosave: boolean
  maxOutputChars: number
  agentCellTimeoutS: number
  idleMinutes: number
  approval: 'auto' | 'always' | 'never'
}

export function resolveSettings(config: Config): Settings {
  return {
    python: config.python === undefined || config.python === '' ? undefined : config.python,
    autosave: config.autosave ?? true,
    maxOutputChars: config.maxOutputChars ?? 200_000,
    agentCellTimeoutS: config.agentCellTimeoutS ?? 120,
    idleMinutes: config.idleMinutes ?? 30,
    approval: config.approval ?? 'auto',
  }
}
