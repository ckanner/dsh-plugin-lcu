/**
 * Model-facing tools for LCU.
 *
 * The server owns the tool contract: `js` carries a ~1.5 KB description that is
 * the API manual, and the model is told to read documentation out of the first
 * tool result. So the definitions here are the server's, passed through
 * unchanged — this module only adapts the transport (canonical value, text
 * fallback, durable images) and enforces the visibility rule that only `js` and
 * `js_reset` may reach the model.
 *
 * @module dsh-plugin-lcu/tool
 */

import { isDeepStrictEqual } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ToolDefinition, ToolExecution, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'

import type { LcuConnection, LcuContentBlock, LcuTool } from './connection.ts'
import { MODEL_TOOL_NAMES, LcuError } from './connection.ts'

/** Media types the attachment store admits. */
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Canonical base64: standard alphabet, padded, no embedded whitespace. */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

interface ImageBlock {
  readonly type: 'image'
  readonly data: string
  readonly mimeType: string
}

interface PreparedProjection {
  readonly value: unknown
  readonly content: readonly { readonly type: string; readonly [key: string]: unknown }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The model-facing text for one MCP result.
 *
 * LCU returns documentation and command output as text, and screenshots as
 * separate image blocks, so joining the text blocks is the whole projection;
 * images are appended by {@link prepareProjection}.
 *
 * @param content - the raw MCP content array.
 * @param toolName - the tool, for the empty-result diagnostic.
 * @returns text for the model, never empty.
 */
export function extractText(content: readonly LcuContentBlock[], toolName: string): string {
  const texts: string[] = []
  let images = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image') images += 1
  }
  if (texts.length > 0) return texts.join('\n')
  if (images > 0) return `[${String(images)} image${images === 1 ? '' : 's'}]`
  return `[${toolName} returned no text content]`
}

/**
 * Decode one image block, rejecting anything the store would not accept.
 *
 * @param block - a declared MCP image block.
 * @returns the decoded attachment payload.
 * @throws {Error} when the media type is not admitted or the base64 is not canonical.
 */
export function decodeImage(block: ImageBlock): { data: Buffer; mediaType: string } {
  if (!IMAGE_MEDIA_TYPES.includes(block.mimeType)) {
    throw new Error('the declared media type is not PNG, JPEG, WebP, or GIF')
  }
  if (!CANONICAL_BASE64.test(block.data)) throw new Error('the image data is not canonical base64')
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) throw new Error('the image data is not canonical base64')
  return { data, mediaType: block.mimeType }
}

/** Stable diagnostic text for an image the host could not admit. */
export function imageDiagnostic(block: unknown, reason: string): string {
  const mediaType = isRecord(block) && typeof block.mimeType === 'string' ? block.mimeType : 'unknown media type'
  return `[image unavailable: ${mediaType}; ${reason}; the raw image stays available to programmatic callers]`
}

/**
 * Resolve the attachment store for this call, verifying the model can take images.
 *
 * @param ctx - the plugin context.
 * @param exec - the in-flight call.
 * @returns the attachment store.
 * @throws {Error} with the reason the images cannot be delivered.
 */
async function resolveAttachments(ctx: Context, exec: ToolRunContext): Promise<AttachmentStore> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('no attachment store is mounted')
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('the current model route could not be resolved')
  }
  let info: { inputModalities?: readonly string[] }
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch {
    throw new Error('the current model route could not be verified')
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new Error(`model "${model}" does not declare image input`)
  }
  if (exec.signal.aborted) throw new Error('the tool call was canceled before image storage')
  return attachments
}

/**
 * Build the ordered content blocks for one result: text and images interleaved
 * exactly as the server emitted them, with any inadmissible image replaced by a
 * diagnostic instead of failing the whole call.
 */
async function prepareProjection(
  ctx: Context,
  exec: ToolRunContext,
  content: readonly LcuContentBlock[],
  toolName: string,
): Promise<PreparedProjection['content']> {
  const decoded: { data: Buffer; mediaType: string }[] = []
  const indexes: number[] = []
  const failures = new Map<number, string>()
  content.forEach((block, index) => {
    if (!isRecord(block) || block.type !== 'image') return
    indexes.push(index)
    try {
      decoded.push(decodeImage(block as unknown as ImageBlock))
    } catch (error: unknown) {
      failures.set(index, error instanceof Error ? error.message : String(error))
    }
  })
  if (failures.size > 0) {
    return content.map((block, index) =>
      isRecord(block) && block.type === 'image'
        ? { type: 'text', text: imageDiagnostic(block, failures.get(index) ?? 'another image in the same result was invalid') }
        : block as { type: string },
    )
  }

  let attachments: AttachmentStore
  try {
    attachments = await resolveAttachments(ctx, exec)
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return content.map((block) =>
      isRecord(block) && block.type === 'image'
        ? { type: 'text', text: imageDiagnostic(block, reason) }
        : block as { type: string },
    )
  }

  try {
    const refs = await attachments.saveImages(decoded)
    const byIndex = new Map(indexes.map((index, offset) => [index, refs[offset]] as const))
    return content.map((block, index) => {
      if (!isRecord(block) || block.type !== 'image') return block as { type: string }
      const ref = byIndex.get(index)
      return ref === undefined
        ? { type: 'text', text: imageDiagnostic(block, 'the attachment store returned no reference') }
        : { type: 'image', attachment: ref }
    })
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    return content.map((block) =>
      isRecord(block) && block.type === 'image'
        ? { type: 'text', text: imageDiagnostic(block, `the image could not be stored: ${reason}`) }
        : block as { type: string },
    )
  }
}

/** Host-owned hooks around one call. */
export interface LcuToolOptions {
  /**
   * Awaited before every call, and its rejection fails the call.
   *
   * The runtime's per-turn cleanup is asynchronous: when it outlives the host's
   * wait, acting on the desktop before it finishes is unsafe. This is where the
   * host retries it and refuses the call if it still has not settled.
   */
  readonly beforeCall?: () => Promise<void>
}

/**
 * Build one model-facing tool from a server descriptor.
 *
 * @param descriptor - the tool as `tools/list` reported it.
 * @param connection - the connection this agent's calls go through.
 * @param ctx - the plugin context, used for the attachment store.
 * @param options - host hooks around the call.
 * @returns a registrable tool definition.
 */
export function createLcuTool(
  descriptor: LcuTool,
  connection: LcuConnection,
  ctx: Context,
  options: LcuToolOptions = {},
): ToolDefinition {
  const projections = new WeakMap<ToolExecution, PreparedProjection>()
  const toolName = descriptor.name

  return {
    name: toolName,
    // The server's description is the API manual; never truncate or rewrite it.
    description: descriptor.description,
    parameters: descriptor.inputSchema,
    output: {
      schema: {
        type: 'object',
        properties: {
          content: { type: 'array', items: {} },
          structuredContent: {},
        },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args: unknown, value: unknown) {
        const content = isRecord(value) && Array.isArray(value.content) ? value.content as LcuContentBlock[] : []
        return [{ type: 'text', text: extractText(content, toolName) }]
      },
    },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      // Refuse to touch the desktop while a previous turn's cleanup is unsettled.
      await options.beforeCall?.()
      // The loop hands us parsed model arguments, which can be any JSON value if
      // the model misbehaves; an empty object lets the server report the missing
      // parameter specifically instead of us inventing an error.
      const callArgs = isRecord(args) ? args : {}
      const result = await connection.callTool(toolName, callArgs, { signal: exec.signal })
      const content = result.content
      const text = extractText(content, toolName)
      // MCP isError becomes a thrown error so the runtime records a failed call.
      if (result.isError) throw new Error(text)
      const value: Record<string, unknown> = { content }
      if (result.structuredContent !== undefined) value.structuredContent = result.structuredContent
      if (content.some((block) => isRecord(block) && block.type === 'image')) {
        const projected = await prepareProjection(ctx, exec, content, toolName)
        projections.set(exec, { value, content: projected })
      }
      return value
    },
    projectContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) {
      const projection = projections.get(exec)
      if (projection === undefined) return undefined
      projections.delete(exec)
      if (result.isError === true) return undefined
      // Policy may have replaced the value; only install our images when the
      // canonical value is still the one we prepared them for.
      if (!isDeepStrictEqual(result.value, projection.value)) return undefined
      return projection.content as never
    },
  }
}

/**
 * Build every model-facing tool for one agent's connection.
 *
 * @param connection - the connected LCU session.
 * @param ctx - the plugin context.
 * @returns tool definitions for `js` and `js_reset`, in server order.
 * @throws {LcuError} when the server does not expose the model tools.
 */
export function buildLcuTools(
  connection: LcuConnection,
  ctx: Context,
  options: LcuToolOptions = {},
): ToolDefinition[] {
  const descriptors = connection.modelTools()
  const missing = MODEL_TOOL_NAMES.filter((name) => !descriptors.some((tool) => tool.name === name))
  if (missing.length > 0) {
    throw new LcuError('tools/list', `the server does not expose ${missing.join(', ')}`)
  }
  return descriptors.map((descriptor) => createLcuTool(descriptor, connection, ctx, options))
}

/**
 * Register the model-facing tools in one agent's scope.
 *
 * Registration is per agent rather than at plugin mount because the server owns
 * the schemas: they can only be fetched after connecting, and an agent only
 * needs the capability once it exists.
 *
 * @param agentCtx - the agent's own context; its registrations unwind on disposal.
 * @param connection - the agent's connected LCU session.
 * @param ctx - the plugin context.
 * @returns a disposer that unregisters every tool.
 */
export function registerLcuTools(
  agentCtx: Context,
  connection: LcuConnection,
  ctx: Context,
  options: LcuToolOptions = {},
): () => void {
  const disposers = buildLcuTools(connection, ctx, options).map((definition) => agentCtx.tools.register(definition))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
