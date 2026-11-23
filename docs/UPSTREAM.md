# Upstream changes we are waiting for

Community plugins are pinned from npm and never forked here (see [DESIGN.md](DESIGN.md)); GenUI is the one exception and
lives in [`packages/genui`](../packages/genui) (its own [`UPSTREAM.md`](../packages/genui/UPSTREAM.md) lists every change). When we need a change in one,
it goes upstream as a pull request or an issue, and it is listed here until a released version contains it. A change we
cannot wait for is carried meanwhile as a patch for the exact pinned version (`patches` in [`ohmydsh.json`](../ohmydsh.json),
files in [`profile/patches/`](../profile/patches)). When the upstream change ships: pin the release that contains it,
delete the patch entry and file, and remove the row below.

| Plugin | Upstream | What | Carried as patch |
|---|---|---|---|
| `@kenz1117/dsh-engram` | [kenz1117/dsh-engram#64](https://github.com/kenz1117/dsh-engram/issues/64) | Delay the start-up consolidation pass (it blocked the host for 10 to 25 s) | `dsh-engram@0.13.15.patch` |
| `@changfenhuang/dsh-genui` | [omdsh-dev/dsh-genui#470](https://github.com/omdsh-dev/dsh-genui/pull/470) | `x-post` and `linkedin-post` social post previews | no: built into our fork `packages/genui` (`@t3labs/ohmydsh-genui`) |
