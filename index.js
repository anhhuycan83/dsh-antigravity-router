/**
 * Antigravity router for DeepSeek Harness.
 *
 * Turns every Agent of one profile into a dispatcher whose only execution
 * backend is the Antigravity CLI subagent (`subagent_antigravity`, shipped by
 * the `dsh-subagent-antigravity` bundle).
 *
 * Three per-Agent contributions, all registered inside that Agent's own scope
 * so they shadow that Agent alone and unwind with it:
 *
 * 1. a prompt section (`<antigravity_router>`) stating the routing policy;
 * 2. `tools.restrict({ allow })`, which hides every *global* tool except the
 *    allowlist, and
 * 3. a `tools.guard`, because an Agent's own scope may also hold delegation
 *    tools registered as *scoped* tools (`subagent`, …) that a global
 *    restriction cannot mask. The guard denies their dispatch.
 *
 * One process-wide `system-prompt/assemble` waterfall closes the last gap: it
 * drops non-allowlisted schemas from a routed Agent's assembly, so the model
 * never sees a tool it cannot use. It identifies routed assemblies by the
 * policy section itself, so it needs no scope bookkeeping.
 *
 * Nothing here re-implements delegation: it only removes the alternatives.
 *
 * ## Fallback
 *
 * `fallback: 'permanent'` (default) keeps the strict rule for transient
 * failures — quota, timeout, cancellation stay error-only — but when the
 * backend itself is unusable (missing CLI, bad executable path, signed out,
 * permission policy, incompatible output, generic process exit) the affected
 * Agent is degraded: its three contributions are lifted and a
 * `<antigravity_fallback>` section tells it to do the work itself with the
 * tools it just regained, and to say so. Degrading is per Agent and survives
 * until that Agent is disposed. `fallback: 'never'` restores the strict
 * profile; `fallback: 'all'` degrades on any failure.
 *
 * @module dsh-antigravity-router
 */

/** Plugin id used by the loader and diagnostics. */
export const name = 'antigravity-router'
/** Services used: the agent registry, per-agent prompt scope, and tool masking. */
export const inject = ['agents', 'systemPrompt', 'tools']

/** Prompt section name; scoped, one per Agent layer. */
const SECTION_NAME = 'antigravity-router:policy'
/** Section registry name used after a fallback lifted the routing. */
const FALLBACK_SECTION_NAME = 'antigravity-router:fallback'
/** Sits after the deployment persona (0) and before the tool sections (1000+). */
const SECTION_ORDER = 450

/** Fallback tool name when the row omits it. */
const DEFAULT_TOOL = 'subagent_antigravity'

/** Failure categories that mean "this backend cannot work until a human fixes it". */
export const DEFAULT_PERMANENT_CATEGORIES = Object.freeze([
  'spawn',
  'auth',
  'permission',
  'invalid-result',
  'process-exit',
])

/** Diagnostic prefix the Antigravity provider puts on its safe failure text. */
const DIAGNOSTIC_MARKER = 'Subagent failure (provider: Antigravity'

/**
 * Normalize one raw loader `config` object.
 *
 * The plugin ships no `Config` schema on purpose: it must load in a profile
 * whose dependency graph cannot resolve `@deepseek-ai/schemastery`, so every
 * field is validated here and an absent or malformed value falls back instead
 * of failing activation.
 *
 * @param {Record<string, unknown> | undefined} raw - row configuration.
 * @returns {{
 *   enabled: boolean, toolName: string, allow: string[], applyToLiveAgents: boolean,
 *   fallback: 'permanent' | 'never' | 'all', permanentCategories: string[],
 * }} resolved settings.
 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const toolName = nonEmptyString(source.toolName) ?? DEFAULT_TOOL
  const declared = Array.isArray(source.allow) ? source.allow.filter(isNonEmptyString) : []
  // The router tool always stays visible: an Agent with zero tools is worse
  // than an Agent with the one tool this plugin exists to route through.
  const allow = [...new Set([toolName, ...declared])]
  const fallback = source.fallback === 'never' || source.fallback === 'all' ? source.fallback : 'permanent'
  const declaredCategories = Array.isArray(source.permanentCategories)
    ? source.permanentCategories.filter(isNonEmptyString)
    : []
  return {
    enabled: source.enabled !== false,
    toolName,
    allow,
    applyToLiveAgents: source.applyToLiveAgents === true,
    fallback,
    permanentCategories: declaredCategories.length > 0 ? declaredCategories : [...DEFAULT_PERMANENT_CATEGORIES],
  }
}

/**
 * Build the router policy text for one resolved configuration.
 *
 * @param {{toolName: string}} config - resolved settings.
 * @returns {string} the scoped prompt section body.
 */
export function policyText(config) {
  const tool = config.toolName
  return `<antigravity_router>
This session is a router. Its execution backend is the Google Antigravity CLI, reached through the \`${tool}\` tool. You have no other tools: every other tool name is denied.

Rules:
1. Every request that touches the workspace, the system, the web, an external service, or that needs research, analysis, code changes, or verification MUST be executed by \`${tool}\`. Never claim or imply that you performed such work yourself.
2. The child runs in its own process and cannot see this conversation, your earlier delegations, or anything you have not written down. Write \`prompt\` as a complete, self-contained brief in the user's language: the goal, absolute paths, the facts and constraints you already know, the exact expected deliverable, and how to verify it. Pass \`cwd\` only when the work belongs outside the current directory.
3. Keep \`description\` to 3-5 words in the user's language.
4. Split larger work into sequential delegations (investigate, act, verify). Each later brief must restate what earlier children established, because children share nothing.
5. \`${tool}\` starts the child and returns immediately. After calling it, write one short line naming what is running, then end your turn. When the completion notice arrives, relay the child's final answer faithfully: keep file paths, command output, and error text intact, and do not soften, summarize away, or embellish it.
6. If a delegation fails (missing CLI, authentication, quota, permission, timeout), report the failure category and the concrete fix the user must apply. Do not simulate the work, do not retry the same brief more than once, and never fall back to another backend.
7. Requests that need no work (greetings, clarifying questions, restating a plan) may be answered directly. Asking the user a question in plain prose is always allowed.
</antigravity_router>`
}

/**
 * Build the degraded-mode section used after a permanent backend failure.
 *
 * @param {{toolName: string}} config - resolved settings.
 * @param {string} category - the provider's failure category.
 * @returns {string} the scoped prompt section body.
 */
export function fallbackText(config, category) {
  return `<antigravity_fallback>
The Antigravity backend is unusable in this session (failure category: \`${category}\`), so routing has been lifted for this session only. \`${config.toolName}\` is still available but will keep failing until a human fixes the environment.

Rules now:
1. Tell the user in one line, in their language, that Antigravity is unavailable and why (category + the concrete fix: install the CLI, correct its path, sign in, adjust permissions), then continue.
2. Complete the request yourself with your own tools. Do not pretend the work came from Antigravity, and do not keep retrying \`${config.toolName}\` in this turn.
3. Your other sessions and any new session stay routed; this decision applies to this session only.
</antigravity_fallback>`
}

/**
 * Mount the router.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {Record<string, unknown>} [rawConfig] - row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger?.debug?.('dsh-antigravity-router: disabled by config')
    return
  }

  /** Agents that arrived through `agent/created` (or live opt-in) and may be routed. */
  const eligible = new Set()
  /** Agent -> disposer for its scoped contributions. */
  const installed = new Map()
  /** Agents whose routing was lifted after a permanent backend failure. */
  const degraded = new Set()
  /** Re-entrancy latch: every contribution emits `tools/change`. */
  const busy = new Set()
  let warnedMissingTool = false

  const allowed = name => config.allow.includes(name)

  /**
   * Global tool names the loader currently knows, which is exactly what
   * `tools.restrict()` accepts; an unregistered name would throw.
   *
   * @returns {string[] | undefined} restrictable allowlist, or undefined while the router tool is absent.
   */
  const restrictableAllow = () => {
    const known = config.allow.filter(tool => ctx.tools.get(tool) !== undefined)
    return known.length > 0 ? known : undefined
  }

  const install = agent => {
    if (!eligible.has(agent) || installed.has(agent) || degraded.has(agent) || busy.has(agent)) return
    const scoped = agent.ctx
    if (scoped?.tools?.restrict === undefined || scoped.tools.guard === undefined || scoped.systemPrompt?.section === undefined) return
    const allow = restrictableAllow()
    if (allow === undefined) {
      if (!warnedMissingTool) {
        warnedMissingTool = true
        ctx.logger?.warn?.(
          `dsh-antigravity-router: none of [${config.allow.join(', ')}] is registered yet; routing starts when the delegation tool appears`,
        )
      }
      return
    }

    const disposers = []
    busy.add(agent)
    try {
      disposers.push(scoped.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: policyText(config),
      }))
      disposers.push(scoped.tools.restrict({ allow }))
      disposers.push(scoped.tools.guard(execution =>
        allowed(execution.name)
          ? undefined
          : `Tool "${execution.name}" is disabled in this session: all work must be delegated through "${config.toolName}".`,
      ))
    } catch (error) {
      for (const dispose of disposers.reverse()) {
        try { dispose() } catch { /* already unwound */ }
      }
      ctx.logger?.warn?.(`dsh-antigravity-router: could not route session ${agent.id}: ${error?.message ?? error}`)
      return
    } finally {
      busy.delete(agent)
    }

    installed.set(agent, () => {
      for (const dispose of [...disposers].reverse()) {
        try { dispose() } catch { /* already unwound */ }
      }
    })
  }

  const forget = agent => {
    installed.get(agent)?.()
    installed.delete(agent)
    eligible.delete(agent)
    degraded.delete(agent)
    busy.delete(agent)
  }

  /**
   * Lift the routing for one Agent after a backend failure.
   *
   * @param {object | undefined} agent - the delegating Agent.
   * @param {string} text - the provider diagnostic the parent is about to see.
   */
  const maybeFallback = (agent, text) => {
    if (config.fallback === 'never' || agent === undefined) return
    if (!eligible.has(agent) || degraded.has(agent)) return
    if (!text.includes(DIAGNOSTIC_MARKER)) return
    const category = /category:\s*([a-z][a-z-]*)/i.exec(text)?.[1] ?? 'unknown'
    const permanent = config.fallback === 'all' || config.permanentCategories.includes(category)
    if (!permanent) {
      ctx.logger?.debug?.(`dsh-antigravity-router: transient Antigravity failure (${category}); routing kept for session ${agent.id}`)
      return
    }

    degraded.add(agent)
    installed.get(agent)?.()
    installed.delete(agent)
    ctx.logger?.warn?.(
      `dsh-antigravity-router: Antigravity is unusable (${category}); session ${agent.id} falls back to its own tools`,
    )
    try {
      agent.ctx?.systemPrompt?.section?.({
        name: FALLBACK_SECTION_NAME,
        order: SECTION_ORDER,
        text: fallbackText(config, category),
      })
    } catch (error) {
      ctx.logger?.warn?.(`dsh-antigravity-router: could not announce the fallback to session ${agent.id}: ${error?.message ?? error}`)
    }
  }

  // Hide non-allowlisted schemas from routed assemblies. A routed assembly is
  // one that carries the scoped policy section, so this needs no scope map and
  // never touches an Agent that was not routed.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    if (!assembled.sections.some(section => section.name === SECTION_NAME)) return assembled
    return { ...assembled, tools: assembled.tools.filter(tool => allowed(tool.name)) }
  })

  // A startup failure arrives as the tool's own error result …
  ctx.on('tools/result', (execution, result) => {
    if (execution.name !== config.toolName || result.isError !== true) return
    maybeFallback(execution.agent, contentText(result.content))
  })
  // … while a post-publication failure arrives as the child's notice. The
  // notice is a durable user message that names the failure category.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    maybeFallback(agent, contentText(message?.content))
  })

  if (config.applyToLiveAgents) {
    for (const agent of ctx.agents.list()) {
      eligible.add(agent)
      install(agent)
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    eligible.add(agent)
    install(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    forget(agent)
  })
  // Tool registration order is layer-dependent: retry the Agents that were
  // published before the delegation tool existed.
  ctx.on('tools/change', () => {
    for (const agent of eligible) install(agent)
  })

  ctx.effect(() => () => {
    for (const agent of [...installed.keys()]) forget(agent)
    eligible.clear()
    degraded.clear()
  }, 'antigravity-router.scoped()')
}

/**
 * Flatten the text blocks of a content array.
 *
 * @param {unknown} content - content blocks, or anything else.
 * @returns {string} concatenated text, empty when none.
 */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * @param {unknown} value - candidate.
 * @returns {value is string} whether it is a usable non-empty name.
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

/**
 * @param {unknown} value - candidate.
 * @returns {string | undefined} the value when it is a non-empty string.
 */
function nonEmptyString(value) {
  return isNonEmptyString(value) ? value : undefined
}
