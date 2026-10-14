/**
 * dsh-roleplay — keep a preset's agents on an allow list of tools.
 *
 * Contract: every agent this preset composes can see and call exactly the tools `allow` names.
 * Every other name it would inherit — from the host plane or from any ancestor scope — is
 * invisible, including tools a plugin registers later: the filter is an `allow` SET, not a
 * snapshot of today's names, so installing one more tool plugin never widens what these agents
 * hold.
 *
 * `ctx.tools.restrict()` is the enforcement point, not a presentation filter: dispatch resolves
 * through the same view, so a hidden name answers `unknown tool` even when a caller names it.
 * Four harness facts decide this row:
 *
 * - An agent reaches a preset TWO ways, and both need the restriction. Creation under this preset
 *   dispatches `agent/created` with a scope carrier, so this row — a listener tagged with the
 *   preset's standing scope — receives exactly its own agents and no other preset's. Selecting the
 *   preset on a still-blank session instead REBINDS an agent that already exists and emits
 *   `agent-preset/selected`, whose id names the preset the session now runs; that event carries no
 *   scope, so this row checks the id it is configured with and releases an agent that leaves again.
 * - The restriction is registered on `agent.ctx`, the agent's OWN scope. A restriction filters what
 *   a scope INHERITS — the global layer and every ancestor layer, which is where a preset's own
 *   rows register — and never what the viewing scope's own layer registers. That exemption is what
 *   keeps the delegation runtime's structured-output tool reachable by a delegated child.
 * - A restriction must name tools that exist: `restrict()` rejects an unknown name, which is why
 *   this row checks the agent's visible set and fails loud instead of restricting to nothing.
 * - `config.preset` cannot be inferred from the mounting scope, so it is declared and then verified
 *   against the declaration that actually mounts this module: naming another preset would otherwise
 *   strip THAT preset's agents.
 *
 * Editing this module takes effect only through a fresh import. Node caches an imported module by
 * URL, and `dsh-hmr` clears that cache entry for a file it watches but re-imports only the host
 * Loader's own rows — a row inside a preset is re-imported when the preset is mounted again. A
 * profile that wants an edit here live therefore lists this file as an `hmr` root AND triggers the
 * preset's re-mount (a bundle re-reload), because a plain patch reload reuses the cached module.
 *
 * @module dsh-roleplay/tool-allowlist
 */

/** The module specifier the preset declaration mounts this row under. */
const ROW_MODULE = 'dsh-roleplay/tool-allowlist.js'

/** Cordis plugin name. */
export const name = 'tool-allowlist'

/** Services this plugin reads. */
export const inject = ['tools', 'agents', 'agentPresets']

/**
 * Keep every agent of one preset on `allow`, and only while it is composed under that preset.
 * @param ctx - the preset's standing scope, which receives this preset's agents and their events.
 * @param config - `preset`, the preset this row belongs to, and `allow`, the tool names its agents may see and call.
 */
export async function apply(ctx, config) {
  const preset = config?.preset
  const allow = config?.allow
  if (typeof preset !== 'string' || preset === '') {
    throw new Error('tool-allowlist: config.preset must name the preset that mounts this row')
  }
  if (!Array.isArray(allow) || allow.length === 0
    || allow.some(entry => typeof entry !== 'string' || entry === '')) {
    throw new Error('tool-allowlist: config.allow must be a non-empty array of tool names')
  }
  const document = await ctx.agentPresets.readDocument(preset)
  if (!document.content.includes(ROW_MODULE)) {
    throw new Error(`tool-allowlist: preset ${JSON.stringify(preset)} does not mount ${ROW_MODULE}`)
  }

  /** The restriction each agent currently holds, so an agent that leaves the preset can be released. */
  const held = new WeakMap()

  const restrict = (agent) => {
    if (held.has(agent)) return
    // Fail loud rather than restrict to nothing: a missing name means this preset mounts no such
    // tool, and a silently empty allow list would read as a working, deliberately tool-less preset.
    const visible = ctx.tools.schemas(agent).map(schema => schema.name)
    const missing = allow.filter(name => !visible.includes(name))
    if (missing.length > 0) {
      throw new Error('tool-allowlist: ' + missing.map(name => JSON.stringify(name)).join(', ')
        + " is not among this preset's tools; visible: " + ([...visible].sort().join(', ') || '(none)'))
    }
    held.set(agent, agent.ctx.tools.restrict({ allow }))
  }
  const release = (agent) => {
    held.get(agent)?.()
    held.delete(agent)
  }

  ctx.on('agent/created', ({ agent }) => { restrict(agent) })
  ctx.on('agent-preset/selected', (sessionId, selected) => {
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) return
    // A selection is committed after the rebind, so this reads the preset the agent now runs.
    if (selected === preset) restrict(agent)
    else release(agent)
  })
}
