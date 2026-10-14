/**
 * Diagnostic: does the `tool-allowlist` row hold for both ways an agent joins a preset?
 *
 * Claims under test: the whitelist is a live filter rather than a copy of today's tool names (a
 * tool registered later stays invisible); it applies to an agent that SELECTS the preset on a
 * still-blank session, not only to one created under it; it is released when that agent leaves;
 * it is the agent's own restriction, so a tool the agent's own scope registers survives; and a
 * configuration that names a preset not mounting this row refuses to load.
 *
 * It mounts the real `dsh-tools` registry and the real `dsh-scope` graph, loads the shipped
 * `tool-allowlist.js`, and dispatches `agent/created` through an agent's scope carrier exactly as
 * `dsh-agent` does. Only the two host services the row reads — the registry's declaration text and
 * its session-to-agent lookup — are stubbed, with the scope relations the registry itself builds.
 *
 * Run it from the DeepSeek Harness checkout, whose `tsx` the loader needs:
 * `node --import tsx/esm C:/resource/dsh-roleplay/probe/allowlist-probe.mjs`
 */

import { Context } from '../../deepseek-harness/vendor/cordis/src/index.ts'
import SystemPrompt from '../../deepseek-harness/packages/core/system-prompt/src/index.ts'
import ToolRuntime from '../../deepseek-harness/packages/core/tools/src/index.ts'
import { bindScopeParent, createScope, scopeTarget } from '../../deepseek-harness/packages/core/scope/src/index.ts'
import * as allowlist from '../tool-allowlist.js'

const ROW_MODULE = 'dsh-roleplay/tool-allowlist.js'
const PRESET = 'roleplay'
const OTHER = 'whiting'

/** A registered tool good enough for visibility and dispatch. */
function tool(name) {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: () => Promise.resolve(`ran:${name}`),
  }
}

/** Assert one observed tool list, and print it either way. */
function expectTools(ctx, label, scope, expected) {
  const observed = ctx.tools.schemas(scope).map(schema => schema.name).sort()
  console.log(`${label}:`, JSON.stringify(observed))
  if (JSON.stringify(observed) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label}: expected ${JSON.stringify([...expected].sort())}, saw ${JSON.stringify(observed)}`)
  }
}

/** Mint a scope whose key doubles as a minimal Agent-like object, as the registry does per agent. */
async function mint(ctx, key, parent) {
  let scope
  // Services resolve through the MINTING plugin's dependency chain; in production the agent loop's
  // inject list plays that role for the rows a preset mounts.
  await ctx.plugin(Object.assign((inner) => {
    scope = createScope(inner, key, parent === undefined ? undefined : { parent })
  }, { inject: ['tools', 'systemPrompt', 'agents', 'agentPresets'] }))
  return scope
}

/** Join an agent to a standing scope and announce it the way dsh-agent does. */
async function announce(ctx, agent) {
  await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent })
}

/** Select a preset for a live session the way the registry does on a blank session. */
function select(ctx, agent, preset) {
  ctx.emit('agent-preset/selected', agent.id, preset)
}

async function execute(ctx, name, agent) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: `call-${name}`,
    name,
    arguments: {},
    agent,
  })
  const first = result.content[0]
  return first?.type === 'text' ? first.text : JSON.stringify(result.content)
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(ToolRuntime)

// The stub declarations: the only thing the row reads from the registry is the mounting
// declaration's own text, which it verifies against its module specifier.
const declarations = new Map([
  [PRESET, `- id: persona\n- id: tool-allowlist\n  name: '${ROW_MODULE}'\n  config:\n    preset: roleplay\n`],
  [OTHER, '- id: persona\n'],
  ['impostor', `- id: tool-allowlist\n  name: '${ROW_MODULE}'\n`],
])
ctx.provide('agents', { get: (id) => sessions.get(id) })
ctx.provide('agentPresets', {
  readDocument: async (id) => {
    const content = declarations.get(id)
    if (content === undefined) throw new Error(`unknown agent preset: ${id}`)
    return { agentPreset: id, content }
  },
})
const sessions = new Map()

// The host plane of a real deployment: tools a profile's own rows registered globally.
ctx.tools.register(tool('history_read'))
ctx.tools.register(tool('lsp'))

// `roleplay` as the declaration mounts it: a standing scope holding the persistent shell, plus
// this row.
const roleplayKey = { preset: PRESET }
const roleplay = await mint(ctx, roleplayKey)
roleplay.ctx.tools.register(tool('pwsh'))
await roleplay.ctx.plugin(allowlist, { preset: PRESET, allow: ['pwsh'] })

// The preset a blank session starts on, before the user picks Role play.
const otherKey = { preset: OTHER }
const other = await mint(ctx, otherKey)
other.ctx.tools.register(tool('edit'))

// ── the shipped flow: a blank session is created on the default preset, THEN switched ──────────
const blank = { id: 'session-blank' }
const blankBinding = bindScopeParent(blank, otherKey)
const blankScope = await mint(ctx, blank)
blank.ctx = blankScope.ctx
sessions.set(blank.id, blank)
await announce(ctx, blank)
expectTools(ctx, 'blank session under the default preset', blank, ['edit', 'history_read', 'lsp'])

// Selecting the preset REBINDS the live agent; the registry commits the selection afterwards, so
// the row reads the new composition.
blankBinding.rebind(roleplayKey)
select(ctx, blank, PRESET)
expectTools(ctx, 'after switching the blank session to roleplay', blank, ['pwsh'])

// Switching again releases the restriction with the preset.
blankBinding.rebind(otherKey)
select(ctx, blank, OTHER)
expectTools(ctx, 'after switching back', blank, ['edit', 'history_read', 'lsp'])

// ── creation under the preset, and the filter's behaviour over time ────────────────────────────
const direct = { id: 'session-direct' }
const directScope = await mint(ctx, direct, roleplayKey)
direct.ctx = directScope.ctx
sessions.set(direct.id, direct)
await announce(ctx, direct)
expectTools(ctx, 'session created under roleplay', direct, ['pwsh'])

// The enforcement half: a hidden name is not merely unlisted, it cannot be called.
const denied = await execute(ctx, 'history_read', direct)
console.log('calling a hidden tool:', JSON.stringify(denied))
if (!denied.includes('unknown tool')) throw new Error('a hidden tool still executed')

// Outside change: a tool registered after the restriction must stay hidden from these agents.
ctx.tools.register(tool('installed-later'))
expectTools(ctx, 'after a new global tool', direct, ['pwsh'])

// The exemption that keeps delegation working: a tool the agent's OWN scope registers stays.
directScope.ctx.tools.register(tool('report'))
expectTools(ctx, 'after the agent registers its own tool', direct, ['pwsh', 'report'])

// ── configuration that cannot be trusted fails at load ────────────────────────────────────────
const check = async (label, mounted) => {
  let failure
  try {
    const namespace = await mint(ctx, { probe: label })
    await namespace.ctx.plugin(allowlist, mounted)
  } catch (error) {
    failure = error
  }
  console.log(`${label}:`, JSON.stringify(failure?.message))
  if (failure === undefined) throw new Error(`${label} was accepted`)
}
await check('a preset that mounts another row', { preset: OTHER, allow: ['pwsh'] })
await check('an unknown preset', { preset: 'ghost', allow: ['pwsh'] })
await check('an empty allow list', { preset: PRESET, allow: [] })

// A name this preset does not mount rejects the agent rather than restricting to nothing.
const impostorKey = { preset: 'impostor' }
const impostor = await mint(ctx, impostorKey)
await impostor.ctx.plugin(allowlist, { preset: 'impostor', allow: ['pwsh'] })
const unserved = { id: 'session-unserved' }
const unservedScope = await mint(ctx, unserved, impostorKey)
unserved.ctx = unservedScope.ctx
let unservedFailure
try {
  await announce(ctx, unserved)
} catch (error) {
  unservedFailure = error
}
console.log('a name this preset does not mount:', JSON.stringify(unservedFailure?.message))
if (unservedFailure === undefined || !unservedFailure.message.includes('tool-allowlist')) {
  throw new Error('a missing allow name was accepted')
}

await ctx.fiber.dispose()
console.log('\nthe allow list holds on both join paths, survives later global registrations, and releases with the preset')
