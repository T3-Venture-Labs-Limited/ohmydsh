# Retiring `dsh-image-gen` in favour of `dsh-studio`

Status: **checklist.** Try the steps in a throwaway profile first, and change your main profile only once they pass. This document never asks anyone to edit files inside `node_modules`.

`dsh-studio` is a hard fork of `dsh-image-gen` 0.11.2, so both plugins can be installed side by side. They share nothing: different plugin ids (`studio` vs the upstream id), route prefix (`/plugins/dsh-studio/` vs `/plugins/dsh-image-gen/`), tool names (`studio_*` vs `image_generate`/`generate_image`…), credential names (`DSH_STUDIO_*`), data root (`<DSH_HOME>/studio` vs `<DSH_HOME>/image-gen`) and IndexedDB names (`dsh_studio_*` vs `dsh_image_gen_*`). Retirement is therefore a data migration plus one `remove`, not a rename.

## 0. What retirement removes, what it keeps

| | Removed with the plugin | Survives removal |
|---|---|---|
| Plugin code, its tools (`generate_image`, `edit_image`, `generate_images`, `find_inspiration`, `canvas_state`, `view_canvas`) and routes | yes | |
| Gallery records (IndexedDB `dsh_image_gen_db` in each browser profile that used it) | **no, they stay in the browser** but nothing reads them any more | yes, until the browser storage is cleared |
| Generated image bytes (DSH attachment store, `~/.dsh/attachments`) | no | yes |
| Raw originals vault (`~/.dsh/image-gen/vault`, animated GIFs and un-normalized imports) | no | yes (a few MB here) |
| Credentials stored in DSH credentials | no | yes. `GEMINI_API_KEY`, `OPENAI_API_KEY` and `XAI_API_KEY` are the same references in both plugins. The OpenAI-compatible relay keys were renamed `DSH_IMAGE_GEN_OPENAI_COMPAT_KEY[_<CHANNEL>]` → `DSH_STUDIO_OPENAI_COMPAT_KEY[_<CHANNEL>]`: Studio's v2 providers fall back to the old name when the new one is empty, but the **legacy settings card** only shows the new name, so re-enter the relay key once in Studio's settings |
| Subscription logins (Grok, Antigravity) | no | stored by the subscription layer under its own keys; `dsh-studio` has its own subscription manager and may need one fresh login (see step 3) |
| Settings of the old plugin (provider, model, ComfyUI workflows, workspace folder) | the settings section disappears | the stored values stay in the DSH settings store; `dsh-studio` has its own section with the same field names, enter them once |

Chat history keeps working: old tool cards render from the saved attachment, not from the plugin. After removal an old card whose plugin is gone falls back to the plain image attachment.

## 1. Preconditions (all must be true)

1. `dsh-studio` is installed in the profile you are migrating and the Plugins page lists "Dsh Studio" as active.
2. The Studio sidebar tab opens, the gallery loads, and a generation with the default provider (grok-sub) completes.
3. `docs/API.md` flows used by the migration answer on the web server: `GET /plugins/dsh-studio/v2/import-legacy/status` returns `{ vaultFiles, importedItems, vaultDirs }`.
4. A backup exists: copy `~/.dsh/image-gen`, `~/.dsh/attachments` and the browser profile's site data for the DSH origin (or export the old gallery as a ZIP from the old Image Studio before anything else).

## 2. Migrate the data (in the browser that holds the gallery)

1. Open DSH in the browser that was used with `dsh-image-gen` (IndexedDB is per browser and per origin; a different browser, or `127.0.0.1` versus another hostname, is a different database).
2. In the Studio gallery choose **Import from Image Studio**. It reads `dsh_image_gen_db` (`gallery_history`, `favorite_prompts`), sends the records in batches of 25 and the host reads each image from the attachment store, then imports vault originals nobody referenced.
3. Read the summary: `imported + already there + missing = total records`. `missing` means the image file itself no longer exists (the attachment store was pruned); those entries cannot be recovered by anyone, note the count.
4. Run the import a second time: it must report everything as already there, and the Studio gallery count must not change.

Checks that prove it worked:

- Gallery count in Studio ≥ imported count; the tag `legacy` filters exactly the imported items.
- Open three old items: image shows, prompt, model and date are the old ones, favourites are still favourites.
- An old *edited* image shows its source in the lineage panel.
- `GET /plugins/dsh-studio/v2/import-legacy/status` shows `importedItems` equal to the imported count and `vaultFiles` equal to the number of files in `~/.dsh/image-gen/vault`.

## 3. Verify feature parity before removing anything

Do these in the Studio tab and tick each one. Anything that fails blocks retirement.

| Old feature | Where in Studio | Result |
|---|---|---|
| Generate with grok-sub / google-sub | Composer, provider picker | |
| Generate with Google (`GEMINI_API_KEY`), OpenAI-compatible channels, xAI | Composer (needs the key in Settings → Plugins → Studio) | |
| ComfyUI workflow | Composer, ComfyUI models (workflows are re-imported in the Studio settings section) | |
| Edit with references | Composer, add references | |
| Canvas (draw / compose) | Dropped on purpose: the infinite canvas depended on tldraw, whose licence permits production use only with a paid key. Side-by-side comparison, source picking and drawing a mask remain available through the Gallery compare dialog, the reference tray / "Use as reference" and the Inpaint mask editor | |
| Gallery search, favourites, tags, collections | Gallery | |
| ZIP export | Gallery, select → Export | |
| Save to workspace | Asset menu | |
| Chat tool cards for generated images | Ask the agent to generate an image; the card shows the image | |
| Agent tools | `studio_make`, `studio_gallery`, `studio_models`, `studio_job` exist; the legacy `studio_generate`/`studio_edit` are kept until they are removed in a later release | |
| Subscription login | Settings → Plugins → Studio, "Sign in" for Grok / Antigravity | |

Things the old plugin did **not** have and Studio adds: video, inpaint/outpaint, upscaling, job history with cost, HyperFrames hand-off. Things dropped on purpose: the inspiration library, GIF output, Seedream / DashScope / Zhipu / ChatGPT-subscription providers (use OpenRouter or Replicate for those models).

## 4. Remove it

Only after §1–§3 are green. This is the one command that removes the old plugin; restart DSH afterwards:

```sh
dsh plugin --profile <profile> remove dsh-image-gen
# then restart DSH
```

Then:

1. Confirm DSH starts without plugin load errors.
2. Reload the browser tab (hard refresh) and check the Plugins page: "Dsh Image Gen" is gone, "Dsh Studio" is active, the right-sidebar menu has "Studio" and no "Image Studio".
3. Open an old chat with generated images: the images still render.
4. Generate one image from the agent to confirm tools still work.

Rollback if anything is off: `dsh plugin --profile web add dsh-image-gen@0.11.2`, restart, and keep using it; the migration is non-destructive (nothing was deleted from the old gallery or vault), so it can be repeated later.

## 5. Optional cleanup (any time later, none of it is required)

- Delete the old IndexedDB in the browser (DevTools → Application → IndexedDB → `dsh_image_gen_db`, `dsh_image_gen_thumbs`) once Studio has the images and a backup exists.
- Remove `~/.dsh/image-gen/vault` once `import-legacy/status` shows every file was imported (`vault` import imports them as assets under `~/.dsh/studio/assets`; the old files are only copies now).
- Old relay keys (`DSH_IMAGE_GEN_OPENAI_COMPAT_KEY*`) can be unset once the same key is saved under the `DSH_STUDIO_*` name.

## 6. Known gaps to tell the user about

- Records whose image file is already gone from the attachment store import as `missing`; their prompts are lost with them (the gallery record is only imported together with its image).
- Gallery data is per browser origin. Import from every browser/origin that holds a gallery; duplicates are not created (same image bytes map to one stored file, and each legacy id maps to one asset).
- The thumbnail cache (`dsh_image_gen_thumbs`) is not migrated; Studio regenerates thumbnails on demand.
- Chat cards created by the old plugin keep the old card layout until they are re-rendered by Studio's card.
