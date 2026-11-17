# dsh-notebook

Jupyter notebooks in the DeepSeek Harness sidebar that **you and the agent work in together**.

Click any `.ipynb` file in the Files tree and it opens as a real notebook in the right sidebar. The agent opens the *same* notebook with `nb_*` tools and runs cells on the *same* kernel, so variables, outputs and edits stay in sync, and everything it does appears in your view as it happens.

- **One host-owned ipykernel per notebook**, shared by the sidebar and the agent. Interrupt kills a runaway cell; a timeout interrupts instead of leaving the kernel busy; the whole process tree is killed on stop, and a watchdog cleans up if dsh dies.
- **Push, not polling.** Every edit, run state and output chunk is pushed to open views over one Typert stream per notebook (`dshNotebook/events`) on DSH's single multiplexed WebSocket, open only while the page is visible (no HTTP stream, so open notebooks never use up the browser's 6 connections per host). The client has no timers that hit the server.
- **Eight compact agent tools** (`nb_open`, `nb_read`, `nb_edit`, `nb_run`, `nb_output`, `nb_kernel`, `nb_vars`, `nb_env`). Output is capped, ANSI is stripped, plots come back as **image attachments** (never base64 in text), and the full result stays in the notebook. A bundled `notebook` skill teaches the workflow.
- **Approval-aware execution.** Cell code runs outside the shell sandbox, so a model-driven run goes through `tools/pre-execute` → `ask` unless the session is in full-access mode. Your own Run clicks are never gated. Paths are confined to the session workspace; read-only sessions can view but not edit or run.
- **Faithful `.ipynb`.** Read and written without nbformat, byte-compatible with Jupyter (sorted keys, indent 1, text as lines). Markdown `attachments`, widget state and unknown keys survive; untouched cells are written back exactly as read.
- **Safe rich outputs.** Images, LaTeX (KaTeX → MathML), JSON, ANSI tracebacks; HTML, SVG and JavaScript run in an opaque-origin sandboxed iframe with a no-network CSP. Plotly and ipywidgets are preserved in the file but not drawn.
- **Stale-output hint.** When a notebook opens with outputs saved by an earlier kernel and nothing has run on the current one, a banner offers **Re-run all** (dismissible; it returns after a restart).
- **Python environments that fit uv.** Finds the notebook's pinned interpreter, `DSH_NOTEBOOK_PYTHON`, the `python` setting, a project `.venv` / `venv` (searched from the notebook's folder up to the workspace), `$VIRTUAL_ENV`, `~/.venvs`, conda environments, then `python3`/`python` on PATH, preferring one that already has `ipykernel`. **Create notebook environment** makes `<folder>/.venv` with `uv` and installs `ipykernel`.

## Install (dev)

```sh
pnpm install --ignore-scripts && pnpm run build
dsh plugin --profile <profile> add "dsh-notebook@link:$PWD"
# then restart DSH
```

The interpreter needs `ipykernel` and `jupyter_client`: `uv pip install --python .venv/bin/python ipykernel jupyter_client`, or use the in-app helper.

## Settings (`cordis.patch.yml` row `config:`)

| Key | Default | Meaning |
|---|---|---|
| `python` | none | Interpreter when a notebook pins none and no project env is found |
| `autosave` | `true` | Write edits and outputs shortly after each change |
| `maxOutputChars` | `200000` | Per-cell cap on stored stream text |
| `agentCellTimeoutS` | `120` | Per-cell limit for agent runs (0 = none) |
| `idleMinutes` | `30` | Stop a kernel with no open view and no running cell |
| `approval` | `auto` | `auto` asks unless full-access, `always`, `never` |

## Opening `.ipynb` here instead of in dsh-better-sidebar

The sidebar's tab registry ranks candidates by **priority band, then by the length of the longest matching pattern, then by registration order**. dsh-better-sidebar claims `dsh-resource://file/**` (22 characters) in the same `extension` band, so a bare `*.ipynb` (7 characters) would lose. This plugin registers `dsh-resource://file/**/*.ipynb` (30 characters), which wins, and `canOpen` re-checks the extension. `.py` and every other file stay with better-sidebar.

## Layout

```
python/kernel_driver.py   ipykernel sidecar (JSON lines over stdio)
src/core/                 wire types, no-nbformat .ipynb layer, output digest
src/host/                 document + kernel owner, routes (RPC + raw), push stream, tools, approval gate, interpreter discovery
src/client/               entry (tiny) + lazy view / CodeMirror / KaTeX chunks
src/kit/                  copy of dsh-kit/ui
skills/notebook-workflow/ bundled skill
```

## Credits

Forked from [kikulmj/dsh-jupyter](https://github.com/kikulmj/dsh-jupyter) (Apache-2.0); kernel driver and the no-nbformat `.ipynb` approach from [beihzb/dsh-notebook](https://github.com/beihzb/dsh-notebook) (MIT). See [NOTICE](NOTICE).

## Licence

Apache-2.0, see [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
