# Dsh Studio

A personal image and video studio for DeepSeek Harness: generate, edit, repaint parts of an image, extend a picture beyond its
edges, enlarge images and videos, animate stills, and keep everything in one searchable library, from the chat or from the
Studio tab. It is a hard fork of [`dsh-image-gen`](https://github.com/shanliuling/dsh-image-gen) (Apache-2.0).

## Get started in two minutes

1. Open **Settings → Plugins → Dsh Studio** and add **one** key. The easiest is **OpenRouter** (images and most video models
   with a single bill) or sign in to the **Grok** or **Google** subscription (no key, no per-image cost).
2. Open the **Studio** tab in the right sidebar (under **More** if it is hidden), type a prompt, press Generate.
3. Or just ask the agent: *"make a picture of a red paper boat"*, or paste an image and say *"make the sky purple"*.

## What it can do

| Operation | What you get | Needs |
|---|---|---|
| Generate | An image or a short video from text, optionally guided by reference images or first/last frames | any provider |
| Edit | Change an existing image with words ("make the sky purple") | an image-to-image model |
| Inpaint | Repaint only the area you painted over, leave every other pixel exactly as it was | a model with inpaint |
| Outpaint | Grow the canvas to any side and let a model fill the new area | a model with inpaint |
| Upscale | Enlarge an image or a video | OpenRouter (video it generated) or Replicate |
| Animate | Turn a still into a video, optionally with a last frame | a video model |
| Restyle / extend video | Change a video with a prompt, or continue it | Replicate or Google |

Results are saved to the **library**: full-text search of prompts, tags, favourites, collections, a **lineage** view (this
image was edited from that one, upscaled from this one), ZIP export, and the exact settings and cost of every result.

## Providers and keys

Keys are stored with DSH credentials (never in plain settings). Each can also come from an environment variable.

| Provider | Key name | Good for | Get a key |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | One account for many image and video models (Veo, Kling, Seedance, Wan, FLUX, GPT Image, Nano Banana) | openrouter.ai/keys |
| Replicate | `REPLICATE_API_TOKEN` | Inpainting models, image and video upscalers, video edit and extend | replicate.com/account/api-tokens |
| Google Gemini | `GEMINI_API_KEY` | Nano Banana images and Gemini Omni video straight from Google | aistudio.google.com/apikey |
| Grok subscription | sign in | Images included in your subscription | Settings card |
| Google subscription | sign in | Images included in your subscription | Settings card |
| OpenAI, OpenAI-compatible relays, xAI | key + base URL | Your own endpoints, several named channels | Settings card |
| ComfyUI | workflow | Your local workflows (import an API-format JSON) | Settings card |

Not every key is needed. A provider without a key simply does not appear in the model picker.

## Inpaint and outpaint

**Inpaint.** Open an image, choose *Inpaint*, paint the area you want changed (white is "change this"), describe what should be
there, and run it. Studio adapts the mask to each model automatically (some want it inverted, some want an overlay instead),
and afterwards pastes the result back over your original, so everything outside your brush is **identical to the source, pixel
for pixel**. An empty mask or a mask covering the whole picture is refused before anything is spent.

**Outpaint.** Choose *Expand canvas*, enter how many pixels to add on each side (the finished image can be at most 8192 px wide or tall), and give a
prompt. Studio extends the picture, marks the new area (plus a thin band of the old image so the seam blends), and runs an
inpaint. The seam is blended smoothly instead of leaving a visible step.

Models with inpaint today: GPT Image 2.6 (OpenRouter), FLUX Fill Pro, Ideogram 4.5 Precise Edit and Bria GenFill (Replicate).
Gemini models edit by description only and do not take a mask.

## HyperFrames hand-off

Send images and clips from the library to [HyperFrames](https://hyperframes.heygen.com) to cut them into a finished video. Studio
creates a project folder under `<DSH home>/studio/hyperframes/<name>`, links your files in, and starts HyperFrames' own editor
on your machine (it listens on `127.0.0.1` only, with no sign-in, so it is never exposed to the network). When you have
rendered a video there, **Import renders** brings each finished file back into the library as a new video that remembers
which clips it was made from. Requires the `hyperframes` command on the machine that runs DSH (`npm i -g hyperframes`).
Studio turns off HyperFrames' telemetry and update checks when it starts it.

If you open DSH from another computer, the embedded editor cannot be shown (it lives on the DSH machine's loopback); open it
there, or import renders from anywhere.

## Costs

- Every job shows an **estimate before you run it** and the **recorded cost after**. The cost comes from the provider when it
  reports one and is an estimate otherwise (shown as such). Subscription providers show "$0 (included)".
- There are **no spending limits**: Studio does not stop you. Look at the estimate, especially for video.
- Estimates can be lower than the real bill. Example: a 2 s 480p Wan 3.0 clip was listed at $0.05/s but cost $0.21 because
  audio is generated by default. Turn off *Generate audio* when you do not need it.
- Typical prices: images $0.03 – $0.13; inpaint $0.04 – $0.13; image upscale $0.04 – $0.05; video $0.05 – $0.40 per second
  depending on model and resolution.
- *Spend* in the library shows what each day cost, per provider.

## Limits worth knowing

- **Video upscale or restyle** of a clip made by OpenRouter only works within about 24 hours of generating it (OpenRouter only
  accepts a public link to the clip). For older clips or clips from elsewhere, use a Replicate video model.
- **Replicate output links expire after one hour**; Studio downloads results immediately, so nothing is lost, but a failed
  download cannot be retried later.
- **Gemini Omni** needs a paid Google tier; editing or extending an *uploaded* video is not available in the EEA, Switzerland
  and the UK (clips Gemini made itself work everywhere). First-and-last-frame videos are 3 – 10 s; extensions add 3 – 10 s up to
  30 s; up to 6 reference images.
- Reference images are sent inline: keep the total under about 18 MB for Google. Replicate takes files up to 256 kB inline and Studio uploads larger
  ones for you.
- Jobs survive page reloads and DSH restarts. A job that was in the middle of *sending* when DSH stopped is marked lost and
  **never re-sent**, so you are not charged twice.
- Animated GIF output is not supported (the old Image Studio's GIF mode was removed).
- Studio's HTTP API and the model-facing tools are documented in `docs/API.md` for developers.

## Asking the agent

The agent has four tools. You rarely need to name them:

- `studio_make`: generate, edit, inpaint (`mask`), outpaint (`expand`), upscale, animate, restyle, extend. Attach an image to
  the chat and say what to change; send several prompts in one go (up to 10) for variations.
- `studio_models`: what is available and what it costs. `studio_job`: check, wait for, cancel or retry a job.
  `studio_gallery`: search the library.

The agent picks a model itself unless you name one. Video jobs run in the background and report back when done.

## Moving from the old Image Studio (`dsh-image-gen`)

Open the library and use **Import from Image Studio**: it copies your old gallery (images, prompts, favourites, tags, dates,
edit chains) and any originals left in the old vault. It is safe to run twice. The full checklist for removing the old plugin
afterwards is in `docs/RETIRE-IMAGE-GEN.md`.

## Where things are stored

Everything lives under `<DSH home>/studio`: the library database (`studio.db`), the images and videos (content-addressed, so
identical files are stored once) and HyperFrames projects. Deleting an item hides it immediately and removes the file after 30
days if nothing else uses it.

## Coexisting with dsh-image-gen

Dsh Studio uses its own ids, routes (`/plugins/dsh-studio/`), tool names (`studio_*`), credential names (`DSH_STUDIO_*`),
browser storage (`dsh_studio_*`) and settings namespace, so both plugins can be installed together.
