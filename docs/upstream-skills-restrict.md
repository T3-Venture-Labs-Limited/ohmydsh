# Upstream issue draft: a filter hook on the skill registry (`skills.restrict()`)

Target: `@deepseek-ai/dsh-skill` (`SkillRegistry`), DSH 0.2.2-rc.x. Written by Skill studio (`dsh-skill-studio`).

## Summary

A plugin that wants to hide certain skills **inside DSH only** (without renaming, moving or editing the skill files,
which other agents such as Claude Code and pi read from `~/.agents/skills`) has no supported way to do it today. We
request a small registry-level filter hook, modelled on `ctx.tools.restrict(filter)`.

## Motivation

* `~/.agents/skills` is shared between several agents. Disabling a skill for DSH must not mutate those files
  (`disable-model-invocation` / `user-invocable` frontmatter would change every agent's behaviour).
* There is no allow/deny list anywhere in the skill stack: `SkillRegistry`'s config only has
  `collectCacheMaxEntries`; `skill-filesystem` can only drop whole roots; `tool-skill` only applies the per-skill
  `invocation` flags.
* A "tombstone" runtime skill cannot work: runtime skills in the global layer lose to preset-layer providers
  ("the nearest layer's entry wins a duplicate name outright"), and DSH's web profile mounts the user's skill folder
  per preset (`standard`, `ptc`, `cordis`, `minimal`).
* Filtering the catalog message in `agent/pre-step` is not enough: the `skill` tool and `/name` injection would
  still resolve the skill, and rewriting the catalog every step churns the prompt prefix (KV cache).

Every consumer already reads the registry through `list`, `snapshot` and `get` (tool-skill catalog + `skill` tool +
`/name` injection, api-session-controller's `/` menu, plugins such as dsh-context). One hook there covers all of them.

## What we do today (and why we would rather not)

`dsh-skill-studio` wraps the three read methods on the live `SkillRegistry` instance and filters by a DSH-only
disabled set (`Symbol.for('cordis.original')` unwraps the traceable proxy). Verified on 0.2.2-rc.3: a disabled skill
disappears from the model's `<available_skills>`, from the `skill` tool ("unknown or no longer available") and from
`/name` injection, and the next catalog change is one appended `renderCatalogUpdate` message (prefix cache untouched).

This is an instance patch of a non-extensible service. It is version-gated (`engines.dsh`), fail-open (unexpected
registry shape, runtime result drift or a throwing predicate leaves DSH untouched and logs once) and restored on
dispose, but it is still outside any documented extension point and relies on `list()` calling `this.snapshot()`.

## Proposal

```ts
class SkillRegistry {
  /**
   * Hide skills from every read (`list`, `snapshot`, `get`) without unregistering them.
   * The predicate runs per summary with the same view options the caller used (`cwd`, `scope`).
   * @returns disposer removing this restriction.
   */
  restrict(filter: (skill: SkillSummary, options: SkillViewOptions) => boolean): () => void
}
```

* Semantics: a skill for which any active filter returns `false` is absent from `list`/`snapshot` and `get`
  returns `undefined`. Shadowing is resolved first (name-level), then restrictions apply, so a restricted winner does
  not expose the shadowed duplicate. (We would accept the opposite if the maintainers prefer, as long as it is documented.)
* Invalidation: `restrict()` and its disposer call `invalidateCache()`; consumers already re-snapshot on `skills/change`.
* Same registration discipline as `ctx.tools.restrict`: files into the calling context's scope layer, disposed with the
  caller's fiber.
* Optional: expose the unfiltered view (`list({ includeRestricted: true })`) so a manager UI can show hidden skills.

## Alternatives considered

| Option | Why not |
|---|---|
| Wrapper provider re-exposing the filesystem skills minus a list | Needs one registration per preset layer; presets are replaced wholesale when overridden, so every DSH upgrade can freeze the shipped preset. |
| Same-name tombstone skill | Loses to nearer layers and project roots (rank 100/200 < runtime 250). |
| Edit `disable-model-invocation` in the skill files | Mutates files shared with other agents. |
| `ctx.tools.guard` on the `skill` tool | The model still sees the skill in its catalog; `/name` still works. |

## Acceptance

With the hook in place `dsh-skill-studio` deletes its instance patch and registers one `restrict()` call.
