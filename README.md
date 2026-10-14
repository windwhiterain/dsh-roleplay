# dsh-roleplay

A role-play agent preset for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Select **Role play** when starting a task and the agent gets a persistent shell, an empty system
prompt, and exactly one tool. Everything the character is comes from the conversation.

## What it composes

| Row | Effect |
|---|---|
| `@deepseek-ai/dsh-persona` | Empty prefix, `complete: true`, `includeRuntimeContext: false` |
| `persistent-shell` (`cordis:group`) | One PTY per session plus one persistent shell tool per platform |
| `tool-allowlist` | `dsh-roleplay/tool-allowlist.js`, `preset: roleplay`, `allow: ['pwsh']` or `['bash']` |

Nothing else. In particular there is no `agent-instructions` row.

## What the model sees

The preset is a copy of the shipped `minimal` preset with four deliberate differences.

### No workspace instructions

The shipped `agent-instructions` row is not mounted, so no `AGENTS.md`, `CLAUDE.md`, or
`$DSH_HOME/AGENTS.md` content is injected. The Web bundle already disables that row on the host
plane, so omitting it here is the complete mechanism — a preset owns what one session adds, and
this one adds no instruction loading.

### An empty system prompt

The persona row is mounted for what it suppresses, not for what it says.

- `prefix: ''` contributes no character text and shadows the deployment persona.
- `complete: true` makes that empty prefix the entire system prompt. This is what removes the
  fixed `harness:identity` section (`You are an AI agent powered by DeepSeek Harness.`) that
  `dsh-system-prompt` registers for every agent, along with any other registered section.
- `includeRuntimeContext: false` suppresses the runtime-context snapshots (sandbox mode, approval
  policy, working directory, platform), so no `Current runtime context` block enters the history.

The rendered system prompt is therefore the empty string. Dropping the persona row entirely would
restore both the harness identity line and the runtime-context block.

### One persistent shell

The `persistent-shell` group is copied verbatim from `minimal`: `@deepseek-ai/dsh-terminal` with a
platform-selected backend, and `@deepseek-ai/dsh-tool-bash-persistent` on POSIX or
`@deepseek-ai/dsh-tool-pwsh-persistent` on Windows. Environment, working directory, and history
survive across calls. To role-play with no tools at all, remove both the `persistent-shell` group
and the `tool-allowlist` row from `cordis.patch.yml`.

### A tool whitelist that survives outside changes

A preset only ADDS rows; it cannot remove a registration another plane already made, so every
host-plane tool in the deployment reaches every agent. A profile that installs tool-providing
plugins — history access, subagent templates, an LSP bundle — therefore shows those tools to a
role-play agent too. The `tool-allowlist` row closes that hole.

`tool-allowlist.js` keeps the whitelist, and it covers BOTH ways an agent reaches the preset:

- **Creation under the preset** dispatches `agent/created` with a scope carrier, so this row — a
  listener tagged with the preset's standing scope — receives exactly this preset's agents and no
  other preset's.
- **Selecting the preset on a still-blank session** does not create an agent; it rebinds one that
  already exists and emits `agent-preset/selected`, whose id names the preset the session now runs.
  That event carries no scope, so the row checks the id it is configured with, and releases an agent
  that later leaves again. A session created on the deployment default and switched to Role play
  reaches the whitelist only through this path.

`ctx.tools.restrict({ allow })` on `agent.ctx`, the agent's own scope, is the mechanism. Three
properties of that call matter:

- **`allow`, never `deny`.** The filter is an allow SET, not a snapshot of today's names, so a tool
  a plugin registers after the agent exists is invisible without any change here. A `deny` list
  would have to name each outside tool and would silently leak every future one.
- **It is enforcement, not presentation.** Dispatch resolves through the same view, so a hidden
  name answers `unknown tool` even if a caller names it directly.
- **It is the agent's own restriction.** A restriction filters what a scope inherits — the global
  layer and every ancestor layer, which is where this preset's own rows register — and never what
  the viewing scope's own layer registers. That exemption is what keeps the delegation runtime's
  structured-output tool reachable by a delegated child; it also means this row does not filter a
  session composed by another preset.

Two configuration mistakes fail loud instead of degrading silently. `config.preset` is verified
against the declaration that actually mounts this module, so naming another preset (which would
strip THAT preset's agents) refuses to load. And an `allow` name this preset mounts no such tool
for rejects the agent, naming the tools that are visible, rather than restricting to nothing.

To widen or narrow what role-play agents hold, edit `config.allow` in
[cordis.patch.yml](cordis.patch.yml); nothing else needs to move.

## Hot reload

Two different things reload, and only one of them is automatic:

| Change | Takes effect |
|---|---|
| `cordis.patch.yml` (a row's config, a row added) | On the profile's next config reload — a profile-patch edit, `dsh plugin`, or a bundle re-reload |
| `tool-allowlist.js` (row code) | Only after a fresh module import |

Node caches an imported module by URL, and `dsh-hmr` re-imports only the Host Loader's own rows; a
row inside a preset is re-imported when that preset is mounted again. So an edit to the row alone
changes nothing — the profile lists this file as an `hmr` root (the watcher then clears its cache
entry) and the preset must be re-mounted afterwards, for example by toggling the bundle in the
plugin manager. A host restart is the blunt alternative.

## Install

The package is a bundle: it ships a patch file plus the one plugin row that patch mounts, declared
through `dsh.bundle.patch`. Add it to a profile and install it there.

```sh
dsh plugin   # or the Web plugin manager, with the spec below
```

Use `link:C:/resource/dsh-roleplay` as the install spec, then restart the host if the profile
manager reports `restart-required`. New tasks then list **Role play** under the custom presets.

## Files

| File | Role |
|---|---|
| `cordis.patch.yml` | The whole package: one `@deepseek-ai/dsh-agent-preset` insert |
| `tool-allowlist.js` | The row that keeps these agents on `config.allow` |
| `package.json` | Bundle manifest (`dsh.bundle.patch`) and the row's export |
| `probe/preset-probe.mjs` | Reads both patch files and proves the composition above |
| `probe/allowlist-probe.mjs` | Mounts the real tool registry and proves the whitelist holds |
| `probe/session-scan.mjs` | Reads a compressed session log to show what actually reached a model |

`preset-probe.mjs` compares this preset's child list against the shipped
`packages/bundle/web-app/presets/minimal.patch.yml`, then mounts the declared persona config
against the real `dsh-system-prompt` service. It fails if the tool rows drift from `minimal`, if any
workspace-instruction row appears, or if the rendered system prompt is not empty.

`allowlist-probe.mjs` mounts the real `dsh-tools` registry with host-plane tools, joins an agent to
a scope that mounts this row, and dispatches `agent/created` through the agent's scope carrier the
way `dsh-agent` does. It fails if a tool registered after the restriction reaches the agent, if a
hidden tool still executes, if the restriction leaks to a session outside the preset, if the
agent's own registered tool is filtered, or if a missing allow name is accepted.

Run both from a DeepSeek Harness checkout:

```sh
node --import tsx/esm C:/resource/dsh-roleplay/probe/preset-probe.mjs
node --import tsx/esm C:/resource/dsh-roleplay/probe/allowlist-probe.mjs
```

They print the assembled sections, contexts, rendered prompt, and each tool list, so a change in
the preset shows up as the exact difference.

`session-scan.mjs` needs no checkout:

```sh
node C:/resource/dsh-roleplay/probe/session-scan.mjs <session directory or session.v4.jsonl.zstd>
```
