/**
 * Diagnostic: what does the `roleplay` preset actually compose, and what reaches the model?
 *
 * Two things need proof that reading the YAML cannot give. First, that the declared child list is
 * the shipped `minimal` composition and nothing else — in particular that no
 * `agent-instructions` row can inject `AGENTS.md`. Second, that the persona row with an empty
 * prefix and `complete: true` really renders the empty system prompt, dropping the fixed
 * `harness:identity` section, and that `includeRuntimeContext: false` empties the context
 * snapshots.
 *
 * It is a reproduction harness, not a test: it reads the shipped files and the repo sources
 * directly, so a copy of the preset that drifts from `minimal` reports the exact difference.
 *
 * Run it from the DeepSeek Harness checkout, whose `tsx` the loader needs:
 * `node --import tsx/esm C:/resource/dsh-roleplay/probe/preset-probe.mjs`
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '../../deepseek-harness/vendor/cordis/src/index.ts'
import SystemPrompt, { renderPrompt } from '../../deepseek-harness/packages/core/system-prompt/src/index.ts'
import { createScope } from '../../deepseek-harness/packages/core/scope/src/index.ts'
import * as Persona from '../../deepseek-harness/packages/preset/persona/src/index.ts'
import { loadCordisYaml, presetDefinitions } from '../../deepseek-harness/scripts/cordis-yaml.ts'

const REPO = fileURLToPath(new URL('../../deepseek-harness/', import.meta.url))
const MINIMAL = `${REPO}packages/bundle/web-app/presets/minimal.patch.yml`
const ROLEPLAY = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** The one preset definition a patch file declares, keyed by its id. */
function definition(file, id) {
  const found = presetDefinitions(loadCordisYaml(readFileSync(file, 'utf8'))).find(entry => entry.id === id)
  if (found === undefined) throw new Error(`${file} declares no preset "${id}"`)
  return found
}

/** Every plugin package named anywhere in one preset's child list, nested groups included. */
function moduleNames(plugins) {
  const names = []
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    if (typeof value.name === 'string') names.push(value.name)
    walk(value.config)
  }
  walk(plugins)
  return names
}

const roleplay = definition(ROLEPLAY, 'roleplay')
const minimal = definition(MINIMAL, 'minimal')

console.log('roleplay child rows:', roleplay.plugins.map(row => row.id).join(', '))
console.log('roleplay modules:', moduleNames(roleplay.plugins).join(', '))

const instructions = moduleNames(roleplay.plugins).filter(name => name.includes('agent-instructions'))
if (instructions.length > 0) throw new Error(`roleplay mounts a workspace-instruction row: ${instructions.join(', ')}`)
console.log('no workspace-instruction row: confirmed')

const [roleplayPersona, roleplayShell, allowlistRow] = roleplay.plugins
const [minimalPersona, minimalShell] = minimal.plugins
if (roleplay.plugins.length !== 3) throw new Error(`unexpected child rows: ${roleplay.plugins.map(row => row.id).join(', ')}`)
if (roleplayPersona.name !== minimalPersona.name) throw new Error('the persona row is not the row minimal mounts')
if (JSON.stringify(roleplayShell) !== JSON.stringify(minimalShell)) {
  throw new Error('the tool row is not identical to minimal:\n'
    + `roleplay: ${JSON.stringify(roleplayShell)}\nminimal:  ${JSON.stringify(minimalShell)}`)
}
console.log('tool row is byte-identical to minimal:', roleplayShell.id)

const expectedShell = new Set(['pty', 'terminal-bash', 'persistent-bash', 'terminal-pwsh', 'persistent-pwsh'])
const shellIds = roleplayShell.config.map(child => child.id)
if (shellIds.length !== expectedShell.size || shellIds.some(id => !expectedShell.has(id))) {
  throw new Error(`unexpected shell rows: ${shellIds.join(', ')}`)
}

// The whitelist row: it must name the shell through a `!!js` platform expression, because the
// shipped rows and the allowed name have to move together when the platform changes, and it must
// name THIS declaration so its self-check can refuse a copy that points at another preset.
if (allowlistRow.id !== 'tool-allowlist' || allowlistRow.name !== 'dsh-roleplay/tool-allowlist.js') {
  throw new Error(`unexpected whitelist row: ${JSON.stringify(allowlistRow)}`)
}
console.log('whitelist declares preset:', JSON.stringify(allowlistRow.config?.preset))
if (allowlistRow.config?.preset !== roleplay.id) {
  throw new Error(`the whitelist names preset ${JSON.stringify(allowlistRow.config?.preset)}, not ${JSON.stringify(roleplay.id)}`)
}
const allowExpression = allowlistRow.config?.allow?.__jsExpr
console.log('whitelist expression:', typeof allowExpression === 'string' ? allowExpression : JSON.stringify(allowlistRow.config))
if (typeof allowExpression !== 'string') throw new Error('the whitelist must be a !!js expression, not a literal list')
if (!allowExpression.includes("'pwsh'") || !allowExpression.includes("'bash'")) {
  throw new Error('the whitelist expression must name both platform shells')
}
if (!allowExpression.includes("process.platform === 'win32'")) {
  throw new Error('the whitelist expression must gate on the platform, like the shell rows it names')
}

const persona = roleplayPersona.config
console.log('roleplay persona config:', JSON.stringify(persona))
if (persona.prefix !== '') throw new Error('the roleplay persona is not empty')
if (persona.complete !== true) throw new Error('the roleplay persona must be the complete system prompt')
if (persona.includeRuntimeContext !== false) throw new Error('the roleplay persona must suppress runtime context')
if (minimalPersona.config.complete !== true || minimalPersona.config.includeRuntimeContext !== false) {
  throw new Error('minimal no longer uses the persona flags this preset copies')
}

// The behavioral half, driven by the values the file above declares.
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment persona must not survive.' })
  ctx.systemPrompt.section({ name: 'first-party:guidance', order: 100, text: 'Use tools.' })
  ctx.systemPrompt.context({ name: 'sandbox:policy', order: 100, text: 'Sandbox is danger-full-access.' })
  const key = { agent: 'roleplay-probe' }
  await createScope(ctx, key).ctx.plugin(Persona, {
    prefix: persona.prefix,
    complete: persona.complete,
    includeRuntimeContext: persona.includeRuntimeContext,
  })
  const assembly = await ctx.systemPrompt.assemble({ scope: key })
  console.log('assembled sections:', JSON.stringify(assembly.sections))
  console.log('assembled contexts:', JSON.stringify(assembly.contexts))
  console.log('renderPrompt:', JSON.stringify(renderPrompt(assembly)))
  if (renderPrompt(assembly) !== '') throw new Error('the rendered system prompt is not empty')
  if (assembly.contexts.length !== 0) throw new Error('runtime context survived suppression')
  if (assembly.sections.some(section => section.name === 'harness:identity')) {
    throw new Error('the harness identity survived the complete section')
  }
} finally {
  await ctx.fiber.dispose()
}

console.log('the roleplay preset renders no system prompt and mounts no instruction row')
