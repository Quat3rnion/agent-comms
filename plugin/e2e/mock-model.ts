/**
 * Scripted mock model behind an OpenAI-compatible `/v1/chat/completions` stub.
 *
 * opencode reaches this server through the `@opencode/ai/providers/openai-compatible`
 * provider package (see ./opencode.ts). No real model API token is needed.
 *
 * A test scripts the model like this:
 *
 *   const model = createMockModel()
 *   model.script("add-login", [
 *     { toolCall: { name: "irc_send", arguments: { target: "#lobby", text: "hi" } } },
 *     { text: "done" },
 *   ])
 *
 * Each request from opencode is matched to a script by a marker. The marker is
 * a session tag like `[[e2e:add-login]]` in the first user message (or in the
 * system prompt). The n-th matching request uses the n-th step of the script.
 */

export interface ChatMessage {
  role: string
  /** Text content, flattened. Array-style content parts are joined. */
  text: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  raw: unknown
}

/** One request that the model server received. */
export interface Recorded {
  /** Sequence number, from 0. */
  index: number
  time: number
  path: string
  stream: boolean
  model: string
  messages: ChatMessage[]
  /** Names of the tools that opencode offered in this request. */
  tools: string[]
  /**
   * `title` for the title-generation request of opencode. `primary` for all other
   * requests (agent loop, compaction, generate).
   */
  kind: "title" | "primary"
  /** The tag from `[[e2e:<tag>]]`, or null when the request has no tag. */
  tag: string | null
  /** All message text joined with newlines. Use it for substring checks. */
  allText: string
  /** Text of the last user message. */
  lastUser: string
  /** Content of the last tool result message, or null. */
  lastToolResult: string | null
  /** A short description of the step that answered this request. */
  answer: string | null
  /** The parsed JSON body of the request. */
  body: unknown
}

export interface ToolCallStep {
  name: string
  /** An object is serialized to JSON. A string is sent as it is. */
  arguments: Record<string, unknown> | string
  id?: string
}

export type Step =
  | { text: string; delayMs?: number }
  | { toolCall: ToolCallStep; delayMs?: number }
  | { toolCalls: ToolCallStep[]; delayMs?: number }
  | { error: { status: number; message: string } }

/** A function step reacts to the conversation. Return undefined to use the default text. */
export type StepFn = (request: Recorded, callIndex: number) => Step | undefined | Promise<Step | undefined>

export type StepSpec = Step | StepFn

/**
 * A string matches when the request tag equals it, or when the request text contains it.
 * A RegExp is tested against the request text. A function decides by itself.
 */
export type Matcher = string | RegExp | ((request: Recorded) => boolean)

export interface ScriptHandle {
  /** Requests that this script answered, in order. */
  readonly calls: Recorded[]
  /** Number of steps that are not used yet. */
  remaining(): number
  /** Remove the script. Later requests go to other scripts or get the default text. */
  remove(): void
}

export interface MockModel {
  /** Base URL for the provider `settings.baseURL`, for example `http://127.0.0.1:41000/v1`. */
  readonly url: string
  readonly port: number
  /** Every request received, in order. */
  readonly requests: Recorded[]
  /** Script the primary (non-title) requests that match `matcher`. */
  script(matcher: Matcher, steps: StepSpec[], options?: { repeatLast?: boolean }): ScriptHandle
  /** Set the title that the title-generation request returns for matching sessions. */
  title(matcher: Matcher, title: string): void
  /** Text for primary requests that no script answers. Default: `ok`. */
  setDefaultText(text: string): void
  /** Wait for a recorded request that satisfies `predicate`. Rejects on timeout. */
  waitForRequest(predicate: (request: Recorded) => boolean, timeoutMs?: number): Promise<Recorded>
  /** Recorded requests that satisfy `predicate`. */
  find(predicate: (request: Recorded) => boolean): Recorded[]
  close(): Promise<void>
}

const TAG_RE = /\[\[e2e:([^\]\s]+)\]\]/

interface ScriptEntry {
  matcher: Matcher
  steps: StepSpec[]
  repeatLast: boolean
  used: number
  calls: Recorded[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (isRecord(part) && typeof part["text"] === "string") return part["text"]
        return ""
      })
      .join("")
  }
  return ""
}

function parseMessages(raw: unknown): ChatMessage[] {
  if (!Array.isArray(raw)) return []
  const out: ChatMessage[] = []
  for (const m of raw) {
    if (!isRecord(m)) continue
    const message: ChatMessage = {
      role: typeof m["role"] === "string" ? m["role"] : "unknown",
      text: flattenContent(m["content"]),
      raw: m,
    }
    if (typeof m["tool_call_id"] === "string") message.toolCallId = m["tool_call_id"]
    const calls = m["tool_calls"]
    if (Array.isArray(calls)) {
      message.toolCalls = calls.flatMap((c) => {
        if (!isRecord(c)) return []
        const fn = c["function"]
        if (!isRecord(fn)) return []
        return [
          {
            id: typeof c["id"] === "string" ? c["id"] : "",
            name: typeof fn["name"] === "string" ? fn["name"] : "",
            arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : "",
          },
        ]
      })
    }
    out.push(message)
  }
  return out
}

function toolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((t) => {
    if (!isRecord(t)) return []
    const fn = t["function"]
    if (isRecord(fn) && typeof fn["name"] === "string") return [fn["name"]]
    return []
  })
}

function matches(matcher: Matcher, request: Recorded): boolean {
  if (typeof matcher === "string") return request.tag === matcher || request.allText.includes(matcher)
  if (matcher instanceof RegExp) return matcher.test(request.allText)
  return matcher(request)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function rough(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

interface Answer {
  text: string
  calls: Array<{ id: string; name: string; arguments: string }>
}

let callSeq = 0

function toAnswer(step: Step): Answer | null {
  if ("error" in step) return null
  if ("text" in step) return { text: step.text, calls: [] }
  const list = "toolCall" in step ? [step.toolCall] : step.toolCalls
  return {
    text: "",
    calls: list.map((c) => ({
      id: c.id ?? `call_e2e_${++callSeq}`,
      name: c.name,
      arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
    })),
  }
}

function describe(step: Step): string {
  if ("error" in step) return `error ${step.error.status}`
  if ("text" in step) return `text: ${step.text}`
  const list = "toolCall" in step ? [step.toolCall] : step.toolCalls
  return `toolCalls: ${list.map((c) => c.name).join(",")}`
}

function chunks(text: string, size: number): string[] {
  if (text === "") return []
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function sse(request: Recorded, answer: Answer, includeUsage: boolean): Response {
  const id = `chatcmpl-e2e-${request.index}`
  const created = Math.floor(Date.now() / 1000)
  const model = request.model
  const encoder = new TextEncoder()
  const promptTokens = rough(request.allText)
  const completionTokens = rough(answer.text + answer.calls.map((c) => c.arguments).join(""))

  const frame = (choices: unknown[], extra: Record<string, unknown> = {}): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices, ...extra })}\n\n`,
    )

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(frame([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]))
      for (const piece of chunks(answer.text, 24)) {
        controller.enqueue(frame([{ index: 0, delta: { content: piece }, finish_reason: null }]))
      }
      answer.calls.forEach((call, i) => {
        controller.enqueue(
          frame([
            {
              index: 0,
              delta: {
                tool_calls: [{ index: i, id: call.id, type: "function", function: { name: call.name, arguments: "" } }],
              },
              finish_reason: null,
            },
          ]),
        )
        for (const piece of chunks(call.arguments, 48)) {
          controller.enqueue(
            frame([
              {
                index: 0,
                delta: { tool_calls: [{ index: i, function: { arguments: piece } }] },
                finish_reason: null,
              },
            ]),
          )
        }
      })
      const finish = answer.calls.length > 0 ? "tool_calls" : "stop"
      controller.enqueue(frame([{ index: 0, delta: {}, finish_reason: finish }]))
      if (includeUsage) {
        controller.enqueue(
          frame([], {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          }),
        )
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

function plain(request: Recorded, answer: Answer): Response {
  const promptTokens = rough(request.allText)
  const completionTokens = rough(answer.text + answer.calls.map((c) => c.arguments).join(""))
  return Response.json({
    id: `chatcmpl-e2e-${request.index}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [
      {
        index: 0,
        finish_reason: answer.calls.length > 0 ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: answer.text === "" && answer.calls.length > 0 ? null : answer.text,
          ...(answer.calls.length > 0
            ? {
                tool_calls: answer.calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  })
}

export function createMockModel(): MockModel {
  const requests: Recorded[] = []
  const scripts: ScriptEntry[] = []
  const titles: Array<{ matcher: Matcher; title: string }> = []
  const waiters: Array<{ predicate: (r: Recorded) => boolean; resolve: (r: Recorded) => void }> = []
  let defaultText = "ok"

  const record = (path: string, body: unknown): Recorded => {
    const b = isRecord(body) ? body : {}
    const messages = parseMessages(b["messages"])
    const tools = toolNames(b["tools"])
    const allText = messages.map((m) => m.text).join("\n")
    const isTitle = messages.some(
      (m) => (m.role === "system" || m.role === "developer") && m.text.includes("You are a title generator"),
    )
    const firstUser = messages.find((m) => m.role === "user")
    const tagSource = [
      firstUser?.text ?? "",
      ...messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.text),
    ]
    let tag: string | null = null
    for (const source of tagSource) {
      const found = TAG_RE.exec(source)
      if (found?.[1] !== undefined) {
        tag = found[1]
        break
      }
    }
    if (tag === null) tag = TAG_RE.exec(allText)?.[1] ?? null
    const users = messages.filter((m) => m.role === "user")
    const tools_ = messages.filter((m) => m.role === "tool")
    const request: Recorded = {
      index: requests.length,
      time: Date.now(),
      path,
      stream: b["stream"] === true,
      model: typeof b["model"] === "string" ? b["model"] : "mock",
      messages,
      tools,
      kind: isTitle ? "title" : "primary",
      tag,
      allText,
      lastUser: users[users.length - 1]?.text ?? "",
      lastToolResult: tools_.length > 0 ? (tools_[tools_.length - 1]?.text ?? null) : null,
      answer: null,
      body,
    }
    requests.push(request)
    return request
  }

  const notify = (request: Recorded): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      if (w !== undefined && w.predicate(request)) {
        waiters.splice(i, 1)
        w.resolve(request)
      }
    }
  }

  const pickStep = async (request: Recorded): Promise<Step> => {
    if (request.kind === "title") {
      const hit = titles.find((t) => matches(t.matcher, request))
      return { text: hit?.title ?? "E2E session" }
    }
    for (const entry of scripts) {
      if (!matches(entry.matcher, request)) continue
      entry.calls.push(request)
      const callIndex = entry.used
      entry.used += 1
      let spec: StepSpec | undefined = entry.steps[callIndex]
      if (spec === undefined && entry.repeatLast) spec = entry.steps[entry.steps.length - 1]
      if (spec === undefined) return { text: defaultText }
      const step = typeof spec === "function" ? await spec(request, callIndex) : spec
      return step ?? { text: defaultText }
    }
    return { text: defaultText }
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: "mock", object: "model", owned_by: "e2e" }] })
      }
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 })
      }
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return Response.json({ error: { message: "invalid json" } }, { status: 400 })
      }
      const request = record(url.pathname, body)
      notify(request)
      const step = await pickStep(request)
      request.answer = describe(step)
      if ("error" in step) {
        return Response.json({ error: { message: step.error.message, type: "e2e_error" } }, { status: step.error.status })
      }
      if ("delayMs" in step && step.delayMs !== undefined && step.delayMs > 0) await sleep(step.delayMs)
      const answer = toAnswer(step)
      if (answer === null) return new Response("unreachable", { status: 500 })
      if (!request.stream) return plain(request, answer)
      const opts = isRecord(request.body) ? request.body["stream_options"] : undefined
      const includeUsage = isRecord(opts) ? opts["include_usage"] !== false : true
      return sse(request, answer, includeUsage)
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    port: server.port ?? 0,
    requests,
    script(matcher, steps, options) {
      const entry: ScriptEntry = { matcher, steps, repeatLast: options?.repeatLast === true, used: 0, calls: [] }
      scripts.push(entry)
      return {
        calls: entry.calls,
        remaining: () => Math.max(0, entry.steps.length - entry.used),
        remove: () => {
          const at = scripts.indexOf(entry)
          if (at !== -1) scripts.splice(at, 1)
        },
      }
    },
    title(matcher, title) {
      titles.unshift({ matcher, title })
    },
    setDefaultText(text) {
      defaultText = text
    },
    find: (predicate) => requests.filter(predicate),
    waitForRequest(predicate, timeoutMs = 15_000) {
      const existing = requests.find(predicate)
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise<Recorded>((resolve, reject) => {
        const waiter = { predicate, resolve: (r: Recorded) => (clearTimeout(timer), resolve(r)) }
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) waiters.splice(at, 1)
          reject(new Error(`mock model: no matching request within ${timeoutMs} ms (${requests.length} recorded)`))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    async close() {
      await server.stop(true)
    },
  }
}
