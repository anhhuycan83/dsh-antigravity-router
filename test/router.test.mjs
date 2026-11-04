/**
 * Behavioural checks for the router bundle, run with `node --test`.
 *
 * The Host Services are faked: these tests assert what the plugin registers on
 * an Agent scope (policy section, restriction, guard), how the assembly
 * waterfall filters tools, and when a permanent backend failure lifts routing.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, fallbackText, policyText, resolveConfig } from '../index.js'

const TOOL = 'subagent_antigravity'
const SECTION_NAME = 'antigravity-router:policy'
const FALLBACK_SECTION = 'antigravity-router:fallback'
const SPAWN_DIAGNOSTIC = 'Subagent failure (provider: Antigravity; stage: process; category: spawn)'
const QUOTA_DIAGNOSTIC = 'Subagent failure (provider: Antigravity; stage: run; category: quota)'

/**
 * Build one fake Host context.
 *
 * @param {{tools?: string[], withRouterTool?: boolean}} options - what the fake registry knows.
 */
function fakeHost({ tools = ['read', 'pwsh', TOOL], withRouterTool = true } = {}) {
  const known = new Set(withRouterTool ? tools : tools.filter(name => name !== TOOL))
  const listeners = new Map()
  const warnings = []
  const ctx = {
    logger: { warn: message => warnings.push(message), debug: () => {}, info: () => {} },
    tools: { get: name => (known.has(name) ? { name } : undefined) },
    agents: { list: () => [] },
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(callback)
      return () => {}
    },
    effect: factory => factory(),
  }
  const fire = async (event, ...payload) => {
    for (const callback of listeners.get(event) ?? []) await callback(...payload)
  }
  return { ctx, fire, warnings, listeners }
}

/** One fake Agent with its own scope; every contribution records its disposal. */
function fakeAgent(id) {
  const calls = { sections: [], restrictions: [], guards: [], disposed: 0 }
  const track = () => () => { calls.disposed += 1 }
  const agent = {
    id,
    ctx: {
      systemPrompt: {
        section: section => {
          calls.sections.push(section)
          return track()
        },
      },
      tools: {
        restrict: filter => {
          calls.restrictions.push(filter)
          return track()
        },
        guard: guard => {
          calls.guards.push(guard)
          return track()
        },
      },
    },
  }
  return { agent, calls }
}

/** The tool result shape `tools/result` hands to observers. */
function toolResult(agent, text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    value: null,
  }
}

test('default config keeps only the router tool and falls back on permanent failures', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.toolName, TOOL)
  assert.deepEqual(config.allow, [TOOL])
  assert.equal(config.applyToLiveAgents, false)
  assert.equal(config.fallback, 'permanent')
  assert.ok(config.permanentCategories.includes('spawn'))
  assert.ok(!config.permanentCategories.includes('quota'))
})

test('allow cannot drop the router tool itself', () => {
  const config = resolveConfig({ allow: ['read'], toolName: TOOL })
  assert.deepEqual(config.allow, [TOOL, 'read'])
})

test('fallback accepts only the documented modes', () => {
  assert.equal(resolveConfig({ fallback: 'never' }).fallback, 'never')
  assert.equal(resolveConfig({ fallback: 'all' }).fallback, 'all')
  assert.equal(resolveConfig({ fallback: 'nonsense' }).fallback, 'permanent')
})

test('a new agent is routed with restrict, guard, and policy', async () => {
  const { ctx, fire } = fakeHost()
  apply(ctx, undefined)
  const { agent, calls } = fakeAgent('session-1')

  await fire('agent/created', { agent })

  assert.deepEqual(calls.restrictions, [{ allow: [TOOL] }])
  assert.equal(calls.sections.length, 1)
  assert.equal(calls.sections[0].name, SECTION_NAME)
  assert.match(calls.sections[0].text, /antigravity_router/)
  assert.match(calls.sections[0].text, /every other tool name is denied/)
  assert.equal(calls.guards.length, 1)
  assert.equal(calls.guards[0]({ name: 'subagent' }), 'Tool "subagent" is disabled in this session: all work must be delegated through "subagent_antigravity".')
  assert.equal(calls.guards[0]({ name: TOOL }), undefined)
})

test('live agents stay untouched unless applyToLiveAgents is true', () => {
  const { ctx } = fakeHost()
  const live = fakeAgent('live')
  ctx.agents.list = () => [live.agent]
  apply(ctx, undefined)
  assert.deepEqual(live.calls.restrictions, [])

  const opted = fakeHost()
  const liveOpted = fakeAgent('live-2')
  opted.ctx.agents.list = () => [liveOpted.agent]
  apply(opted.ctx, { applyToLiveAgents: true })
  assert.deepEqual(liveOpted.calls.restrictions, [{ allow: [TOOL] }])
})

test('a missing delegation tool defers routing instead of emptying the toolbox', async () => {
  const { ctx, fire, warnings } = fakeHost({ withRouterTool: false })
  apply(ctx, undefined)
  const { agent, calls } = fakeAgent('session-2')

  await fire('agent/created', { agent })
  assert.deepEqual(calls.restrictions, [])
  assert.deepEqual(calls.sections, [])
  assert.equal(warnings.length, 1)

  // The tool appears later: the same Agent is routed on the next tools/change.
  ctx.tools.get = name => (name === TOOL ? { name } : undefined)
  await fire('tools/change', {})
  assert.deepEqual(calls.restrictions, [{ allow: [TOOL] }])
})

test('assembly waterfall hides non-allowlisted tools only for routed agents', async () => {
  const { ctx, listeners } = fakeHost()
  apply(ctx, undefined)
  const [assemble] = listeners.get('system-prompt/assemble')
  assert.equal(typeof assemble, 'function')

  const routed = {
    sections: [{ name: SECTION_NAME, text: policyText(resolveConfig()) }],
    contexts: [],
    variables: {},
    tools: [{ name: TOOL }, { name: 'read' }, { name: 'subagent' }],
  }
  const filtered = await assemble(routed, {}, async () => routed)
  assert.deepEqual(filtered.tools, [{ name: TOOL }])

  const untouched = {
    sections: [{ name: 'deployment:persona', text: 'you are…' }],
    contexts: [],
    variables: {},
    tools: [{ name: TOOL }, { name: 'read' }],
  }
  const same = await assemble(untouched, {}, async () => untouched)
  assert.deepEqual(same.tools, [{ name: TOOL }, { name: 'read' }])
})

test('a permanent startup failure lifts routing for that agent only', async () => {
  const { ctx, fire, warnings } = fakeHost()
  apply(ctx, undefined)
  const routed = fakeAgent('session-3')
  const other = fakeAgent('session-4')
  await fire('agent/created', { agent: routed.agent })
  await fire('agent/created', { agent: other.agent })

  await fire('tools/result', {
    name: TOOL,
    agent: routed.agent,
    arguments: {},
    signal: new AbortController().signal,
  }, toolResult(routed.agent, SPAWN_DIAGNOSTIC))

  // The routed agent keeps its policy section and gains the fallback notice.
  assert.equal(routed.calls.sections.length, 2)
  assert.equal(routed.calls.sections[1].name, FALLBACK_SECTION)
  assert.match(routed.calls.sections[1].text, /antigravity_fallback/)
  assert.match(routed.calls.sections[1].text, /category: `spawn`/)
  // All three original contributions were lifted.
  assert.equal(routed.calls.disposed, 3)
  // The unrelated session is untouched.
  assert.equal(other.calls.disposed, 0)
  assert.equal(warnings.length, 1)

  // Routing is not re-installed afterwards.
  await fire('tools/change', {})
  assert.equal(routed.calls.restrictions.length, 1)
  assert.equal(routed.calls.sections.length, 2)
})

test('a transient failure keeps the agent routed', async () => {
  const { ctx, fire } = fakeHost()
  apply(ctx, undefined)
  const routed = fakeAgent('session-5')
  await fire('agent/created', { agent: routed.agent })

  await fire('tools/result', {
    name: TOOL,
    agent: routed.agent,
    arguments: {},
    signal: new AbortController().signal,
  }, toolResult(routed.agent, QUOTA_DIAGNOSTIC))

  assert.equal(routed.calls.disposed, 0)
  assert.equal(routed.calls.sections.length, 1)
})

test('a post-publication failure notice also degrades the parent', async () => {
  const { ctx, fire } = fakeHost()
  apply(ctx, undefined)
  const routed = fakeAgent('session-6')
  await fire('agent/created', { agent: routed.agent })

  await fire('agent/inbox/inserted', {
    agent: routed.agent,
    message: { role: 'user', content: [{ type: 'text', text: `The child stopped.\n${SPAWN_DIAGNOSTIC}` }] },
  })

  assert.equal(routed.calls.disposed, 3)
  assert.equal(routed.calls.sections.length, 2)
})

test('fallback: never and fallback: all behave as configured', async () => {
  const strict = fakeHost()
  apply(strict.ctx, { fallback: 'never' })
  const strictAgent = fakeAgent('session-7')
  await strict.fire('agent/created', { agent: strictAgent.agent })
  await strict.fire('tools/result', {
    name: TOOL,
    agent: strictAgent.agent,
    arguments: {},
    signal: new AbortController().signal,
  }, toolResult(strictAgent.agent, SPAWN_DIAGNOSTIC))
  assert.equal(strictAgent.calls.disposed, 0)

  const loose = fakeHost()
  apply(loose.ctx, { fallback: 'all' })
  const looseAgent = fakeAgent('session-8')
  await loose.fire('agent/created', { agent: looseAgent.agent })
  await loose.fire('tools/result', {
    name: TOOL,
    agent: looseAgent.agent,
    arguments: {},
    signal: new AbortController().signal,
  }, toolResult(looseAgent.agent, QUOTA_DIAGNOSTIC))
  assert.equal(looseAgent.calls.disposed, 3)
})

test('fallback text tells the model to name the category and the fix', () => {
  const text = fallbackText(resolveConfig(), 'auth')
  assert.match(text, /category: `auth`/)
  assert.match(text, /Complete the request yourself/)
  assert.match(text, /subagent_antigravity/)
})

test('disabled config registers nothing', async () => {
  const { ctx, fire, listeners } = fakeHost()
  apply(ctx, { enabled: false })
  const { agent, calls } = fakeAgent('session-9')
  await fire('agent/created', { agent })
  assert.deepEqual(calls.restrictions, [])
  assert.equal(listeners.get('system-prompt/assemble'), undefined)
})
