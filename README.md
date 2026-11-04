---
description: "Router bundle: every session delegates all work to the Antigravity CLI subagent and keeps no other tool."
kind: "package-bundle"
---

# dsh-antigravity-router

Makes a DeepSeek Harness profile run **every** session through the Antigravity
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

## Requirements

| Dependency | Notes |
|---|---|
| `dsh-subagent-antigravity` | must stay enabled; it registers `subagent_antigravity` |
| Antigravity CLI (`agy`) | `agy --version` must answer, and the account must be signed in |

If `agy` is missing, every delegation fails with the plugin's
`Antigravity CLI (agy) was not found` diagnostic. The router does **not** fall
back to the DeepSeek model by design.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` disables both the policy and the restriction |
| `toolName` | `subagent_antigravity` | the delegation tool kept visible |
| `allow` | `[subagent_antigravity]` | extra tool names to keep; `toolName` is always kept |
| `applyToLiveAgents` | `false` | `true` masks already-running sessions at activation instead of after a restart |
| `fallback` | `permanent` | `permanent` lifts routing for one session on a permanent backend failure, `never` keeps the strict rule, `all` lifts on any failure |
| `permanentCategories` | `spawn`, `auth`, `permission`, `invalid-result`, `process-exit` | provider failure categories treated as permanent |

## Fallback

Transient failures — `quota`, `timeout`, cancellation — never lift routing: the
session reports the diagnostic and stops, which is the point of the router.
Permanent failures do, because the backend cannot work until a human fixes it.
The plugin detects both shapes the provider produces: an error result on the
tool call (startup failures) and the completion notice carrying the diagnostic
(post-publication failures). It then:

1. disposes that Agent's policy section, restriction, and guard;
2. registers an `<antigravity_fallback>` section telling the model to name the
   category and the fix, then finish the request with its own tools; and
3. never re-routes that Agent — other sessions stay routed.

The degraded session's tools return on its next request, not in the turn where
the delegation failed.

Override the row's `config` in the profile patch, then reload the profile.

## Verification

A new session's tool list contains `subagent_antigravity` only, and its system
prompt contains the `antigravity_router` section. Sessions that existed before
installation keep their tools until they are recreated.

## Uninstall

`plugin_manager` → `remove_bundle` with `dsh-antigravity-router`, or disable the
row in the profile patch.

## Share this bundle

The bundle is a self-contained folder: `index.js`, `cordis.patch.yml`,
`locale/`, `icon.svg`, and this README. Anyone with it needs DSH 0.2.1-rc.x, the
`dsh-subagent-antigravity` bundle enabled, and a signed-in `agy`.

| Route | How the recipient installs |
|---|---|
| Folder or network share | Plugins → Add, then the absolute path — or `dsh plugin --profile <p> add <path>` plus the name in `dsh.profile.bundles` |
| Packed tarball (`pnpm pack`) | Plugins → Add, then the `.tgz` path |
| Git repository (this folder as the repo root) | Plugins → Add with `git+https://…` or `github:<user>/<repo>` |
| npm registry (`npm publish`) | Plugins → Add with the package name; `private` must be removed first |

Installing through the Plugins page (or `plugin_manager` `install_bundle`) also
selects the bundle in `dsh.profile.bundles`; `dsh plugin add` on its own only
installs the dependency.

The provider settings are **not** part of this bundle. Each recipient writes
their own profile override, because the CLI path and the entitled model differ
per machine:

```yaml
- id: subagent-antigravity
  config:
    command: 'C:\Users\<you>\AppData\Local\agy\bin\agy.exe'  # omit once PATH carries it
    model: gemini-3.8-flash-high                             # must exist in `agy models`
```

## License

MIT.
