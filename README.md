---
description: "Router bundle: every session delegates all work to the Antigravity CLI subagent and keeps no other tool."
kind: "package-bundle"
---

# dsh-antigravity-router

Makes a DeepSeek Harness profile run **every new** session through the Antigravity
subagent (`subagent_antigravity`, shipped by `dsh-subagent-antigravity`).

For each Agent the plugin adds, inside that Agent's own scope:

1. a prompt section `<antigravity_router>` that states the routing rules;
2. a global-tool restriction whose allowlist is `[subagent_antigravity]`;
3. a dispatch guard, because delegation tools registered *scoped* on the Agent
   itself (`subagent`, …) survive a global restriction — the guard denies them;

plus one process-wide `system-prompt/assemble` waterfall that removes
non-allowlisted schemas from a routed Agent's prompt, so the model never sees a
tool it is not allowed to call.

The model therefore cannot read, write, run, search, or fetch by itself: the
only callable tool is the delegation tool, and the policy requires a complete
self-contained brief for every delegation.

## Install

In the Web UI open **Plugins → Add** and paste the git spec:

```
git+https://github.com/anhhuycan83/dsh-antigravity-router.git
```

`github:anhhuycan83/dsh-antigravity-router` is accepted as well. The same spec
works through the `plugin_manager` tool (`action: install_bundle`). Installing
this way adds the package **and** selects it in `dsh.profile.bundles`, so the
plugin is live immediately.

`dsh plugin --profile <name> add <spec>` only installs the dependency; add
`dsh-antigravity-router` to that profile's `dsh.profile.bundles` by hand.

Requires DSH `0.2.1-rc.x` (tested on `0.2.1-rc.5`).

## Requirements — điều kiện cho người nhận

The bundle only takes tools away. It does not install or configure a backend, so
**all five conditions below must hold before it is useful**. If one is missing the
session cannot do the work, and the failure is reported, not hidden.

1. **DSH 0.2.1-rc.x** — the plugin uses `ctx.tools.restrict/guard`,
   `ctx.systemPrompt.section`, `agent/created` and `system-prompt/assemble`
   (tested on `0.2.1-rc.5`).
2. **`dsh-subagent-antigravity` bundle enabled** — it is what registers the
   `subagent_antigravity` tool. Without it the router logs a warning and stays
   inert instead of leaving the session with zero tools.
3. **Antigravity CLI installed and signed in** — `agy --version` must answer and
   `agy models` must list your catalogue (`agy` from the official installer:
   `irm https://antigravity.google/cli/install.ps1 | iex` on Windows,
   `curl -fsSL https://antigravity.google/cli/install.sh | bash` elsewhere).
   If the Host was started before the installer updated `PATH`, give the
   absolute path in `command` below.
4. **A model your account really advertises** — the provider default is
   `gemini-4-argon-medium`, which needs an AI Pro/Ultra subscription. Pick an id
   from `agy models` (for example `gemini-3.8-flash-high`, `claude-sonnet-4-6`).
   A wrong id fails every delegation with `category: product-error`, and that
   category deliberately does **not** lift routing.
5. **The provider override in *your own* profile patch** — this bundle does not
   ship it, because the CLI path and the entitled models differ per machine.
   Without it the default model/path applies and delegation likely fails:

   ```yaml
   - id: subagent-antigravity
     name: "dsh-subagent-antigravity"
     config:
       command: 'C:\Users\<you>\AppData\Local\agy\bin\agy.exe'  # omit once PATH carries agy
       model: gemini-3.8-flash-high                             # must exist in `agy models`
   ```

Two behavioural notes that surprise people:

- Routing is **opt-in per session**: sessions that already existed when the
  plugin loaded keep their own tools. Only sessions created afterwards are
  routed (`applyToLiveAgents: false`, the default).
- The switch never changes the model. Every session still talks to DeepSeek; what
  changes is **who executes the work** — Antigravity through `agy` when routed,
  DeepSeek with its own tools when not.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` disables both the policy and the restriction |
| `toolName` | `subagent_antigravity` | the delegation tool kept visible |
| `allow` | `[subagent_antigravity]` | extra tool names to keep; `toolName` is always kept |
| `applyToLiveAgents` | `false` | `true` masks already-running sessions at activation instead of after a restart |
| `fallback` | `permanent` | `permanent` lifts routing for one session on a permanent backend failure, `never` keeps the strict rule, `all` lifts on any failure |
| `permanentCategories` | `spawn`, `auth`, `permission`, `invalid-result`, `process-exit` | provider failure categories treated as permanent |

Override the row's `config` in the profile patch, then reload the profile.

## Fallback

Transient failures — `quota`, `timeout`, cancellation, `product-error` — never
lift routing: the session reports the diagnostic and stops, which is the point
of the router. Permanent failures do, because the backend cannot work until a
human fixes it.

The plugin detects both shapes the provider produces: an error result on the
tool call (startup failures) and the completion notice carrying the diagnostic
(post-publication failures). It then:

1. disposes that Agent's policy section, restriction, and guard;
2. registers an `<antigravity_fallback>` section telling the model to name the
   category and the fix, then finish the request with its own tools; and
3. never re-routes that Agent — other sessions stay routed.

The degraded session's tools return on its next request, not in the turn where
the delegation failed.

## Verification

A new session's tool list contains `subagent_antigravity` only, and its system
prompt contains the `antigravity_router` section. Sessions that existed before
installation keep their tools until they are recreated.

## Other install routes

| Route | Spec to paste into Plugins → Add |
|---|---|
| This git repository | `git+https://github.com/anhhuycan83/dsh-antigravity-router.git` |
| Local folder or network share | the absolute path of the checkout |
| Packed tarball (`pnpm pack`) | the absolute path of the `.tgz` |
| npm registry (after `npm publish`) | the package name |

## Uninstall

Plugins → the bundle card → **Off** (keeps the package installed) or **Remove**.
The same is available as `plugin_manager` `set_bundle` / `remove_bundle`.

## License

MIT.
