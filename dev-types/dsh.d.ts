/**
 * Development-only declarations for the harness packages this plugin consumes.
 *
 * Transcription of the surfaces actually used, from the running harness's own
 * inspection output. Deliberately not published: the host supplies the real
 * packages at runtime and every import of them here is type-only, so nothing in
 * this file reaches the built plugin.
 */

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-agent
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-agent' {
  import type { Context } from '@deepseek-ai/cordis'

  export type SessionId = string & { readonly __brand?: 'SessionId' }

  /** The live session an agent drives; its log is the durable source of truth. */
  export interface AgentSession {
    readonly header: {
      readonly cwd?: string
      /** Id of the agent preset this session's agent was composed from. */
      readonly agentPreset?: string
    }
    requestHeader(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
  }

  export interface Agent {
    readonly id: SessionId
    readonly options: { readonly provider?: string; readonly model?: string }
    readonly session: AgentSession
    /** Agent-scoped context: contributions unwind on disposal. */
    readonly ctx: Context
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-tools
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-tools' {
  import type { Agent } from '@deepseek-ai/dsh-agent'

  /** A model-facing tool schema, as assembly projects it. */
  export interface ToolSchema {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }

  /** One model-facing content block. */
  export type ContentBlock =
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }
    | { readonly type: string; readonly [key: string]: unknown }

  /** A durable image reference minted by the attachment store. */
  export interface ImageAttachmentRef {
    readonly attachmentId: string
    readonly mediaType: string
    readonly bytes: number
    readonly width: number
    readonly height: number
    readonly name?: string
  }

  /** Immutable identity plus cooperation surface for one call. */
  export interface ToolRunContext {
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly agent?: Agent
    readonly signal: AbortSignal
  }

  /** Normalized outcome handed to post-execute policy and projection. */
  export interface ToolExecutionResult {
    readonly value: unknown
    readonly content: readonly ContentBlock[]
    readonly isError?: boolean
  }

  /** The execution identity a projection callback receives. */
  export interface ToolExecution extends ToolRunContext {}

  /** Declares the tool's canonical JSON value and its text fallback. */
  export interface ToolOutputDefinition {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: never): ContentBlock[]
  }

  /** A complete tool contribution. */
  export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition
    execute(args: never, exec: ToolRunContext): Promise<unknown>
    projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
    readonly timeoutMs?: number
  }

  /** The tool registry a context exposes. */
  export interface ToolRegistry {
    register(definition: ToolDefinition): () => void
    schemas(agent?: Agent): readonly ToolSchema[]
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-system-prompt
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-system-prompt' {
  /** One ordered prompt section. */
  export interface PromptSection {
    readonly name: string
    readonly order: number
    readonly text: string | ((context: unknown) => string)
    readonly interpolate?: boolean
    readonly complete?: boolean
  }

  export interface SystemPromptRegistry {
    section(section: PromptSection): () => void
    context(context: { readonly name: string; readonly order: number; readonly text: string | ((context: unknown) => string) }): () => void
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-attachment
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-attachment' {
  import type { ImageAttachmentRef } from '@deepseek-ai/dsh-tools'

  /** One decoded image ready for durable storage. */
  export interface SaveImageAttachment {
    readonly data: Buffer
    readonly mediaType: string
  }

  export interface AttachmentStore {
    saveImages(images: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-llm
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-llm' {
  export interface ModelInfo {
    readonly inputModalities?: readonly string[]
  }

  export interface LlmService {
    resolveModelInfo(provider: string, model: string, signal: AbortSignal): Promise<ModelInfo>
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-user-questions
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-user-questions' {
  import type { Agent } from '@deepseek-ai/dsh-agent'

  export interface AskUserQuestionOption {
    readonly label: string
    readonly description?: string
  }

  export interface AskUserQuestionItem {
    readonly id: string
    readonly question: string
    readonly detail?: string
    readonly header?: string
    readonly options?: readonly AskUserQuestionOption[]
    readonly multiSelect?: boolean
  }

  export interface AskUserQuestionAnswer {
    readonly answers: readonly {
      readonly id: string
      readonly selected: readonly string[]
      readonly custom?: string
    }[]
  }

  export interface UserQuestionsService {
    ask(request: {
      readonly questions: readonly AskUserQuestionItem[]
      readonly agent?: Agent
      readonly signal?: AbortSignal
    }): Promise<AskUserQuestionAnswer>
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-computer-use
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-computer-use' {
  export type ComputerUseProviderName = string & { readonly __brand?: 'ComputerUseProviderName' }

  export interface ComputerUseRegistry {
    /** Reserves the sole provider slot; a second registration fails. */
    register(name: ComputerUseProviderName): () => Promise<void>
    readonly providerName?: ComputerUseProviderName
  }

  export function ComputerUseProviderName(name: string): ComputerUseProviderName
}

// ---------------------------------------------------------------------------
// @deepseek-ai/dsh-agent-preset-registry
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/dsh-agent-preset-registry' {
  import type { Context } from '@deepseek-ai/cordis'

  export interface AgentPresetsService {
    /**
     * Read the preset a live Agent actually uses.
     *
     * This is the authoritative answer: the session header records the
     * deployment default at creation, which the new-task picker may replace
     * afterwards.
     */
    composedPreset(agentCtx: Context): string | undefined
  }
}

// ---------------------------------------------------------------------------
// @deepseek-ai/cordis
// ---------------------------------------------------------------------------

declare module '@deepseek-ai/cordis' {
  import type { Agent } from '@deepseek-ai/dsh-agent'
  import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
  import type { ComputerUseRegistry } from '@deepseek-ai/dsh-computer-use'
  import type { LlmService } from '@deepseek-ai/dsh-llm'
  import type { SystemPromptRegistry } from '@deepseek-ai/dsh-system-prompt'
  import type { ToolRegistry } from '@deepseek-ai/dsh-tools'
  import type { UserQuestionsService } from '@deepseek-ai/dsh-user-questions'
  import type { AgentPresetsService } from '@deepseek-ai/dsh-agent-preset-registry'

  /** The live-Agent registry, keyed by session id. */
  export interface AgentRegistry {
    get(id: string): Agent | undefined
  }

  export interface Logger {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
  }

  /**
   * The plugin context, narrowed to the services this plugin consumes.
   *
   * Optional services are read with `get()` so a composition without them still
   * activates everything else.
   */
  export interface Context {
    readonly tools: ToolRegistry
    readonly systemPrompt: SystemPromptRegistry
    readonly logger: Logger
    get(name: 'attachments'): AttachmentStore | undefined
    get(name: 'llm'): LlmService | undefined
    get(name: 'userQuestions'): UserQuestionsService | undefined
    get(name: 'computerUse'): ComputerUseRegistry | undefined
    get(name: 'agentPresets'): AgentPresetsService | undefined
    get(name: 'agents'): AgentRegistry | undefined
    get(name: string): unknown
    effect(callback: () => (() => void | Promise<void>)): () => void
    on(event: 'agent/created', listener: (payload: { agent: Agent; signal?: AbortSignal }) => void | Promise<void>): () => void
    on(
      event: 'agent/turn-stopping',
      listener: (payload: { agent: Agent; turn: number; signal: AbortSignal }) => void | Promise<void>,
    ): () => void
    /**
     * The registry re-emits a session's committed preset choice. This fires
     * AFTER `agent/created`: a new task is created with the deployment default
     * and the picker's choice is applied on this event, so it is the only
     * reliable moment to react to the preset a session will actually use.
     */
    on(event: 'agent-preset/selected', listener: (sessionId: string, agentPreset: string) => void | Promise<void>): () => void
    on(event: string, listener: (...args: never[]) => unknown): () => void
  }
}
