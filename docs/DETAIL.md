![Notebook preview](preview.svg)

# Notebook

Open any `.ipynb` file from the Files tree and it opens in the sidebar as a real notebook. You and the agent edit and run the **same** notebook on the **same** kernel: variables you define are visible to the agent's next run, and its edits and plots show up in your view the moment they happen.

## What you get

- One real **ipykernel** per notebook, owned by the host. It outlives the tab and is shut down when idle.
- **Live both ways.** Every edit, run and output is pushed to open views as it happens; there is no refresh and no polling.
- **Eight compact agent tools** (open, read, edit, run, output, kernel, vars, env). Plots come back to the model as image attachments, text output is capped, and the full result stays in the notebook.
- **Approval-aware.** When the session is not in full-access mode, the agent asks you before running cells or creating environments. Your own Run clicks are never gated.
- **Faithful `.ipynb`.** Written exactly like Jupyter writes it (sorted keys, indent 1, text as lines), keeping markdown attachments, widget state and unknown keys. Untouched cells are written back byte for byte.
- **Rich outputs.** Images, LaTeX, JSON, ANSI-coloured tracebacks, and HTML/SVG/JavaScript in an isolated sandboxed frame that cannot reach DSH.
- **Python environments.** Finds a project `.venv`, `DSH_NOTEBOOK_PYTHON`, the plugin setting, venvs and conda, then PATH. "Create notebook environment" makes a `.venv` with uv and installs `ipykernel`.

## Good to know

- Cell code runs on your machine **outside** the shell sandbox, as you. That is why the agent needs approval outside full-access sessions.
- If the file changes on disk while you have unsaved edits, you get a banner to reload or overwrite; nothing is overwritten silently.
- Read-only sessions can view a notebook but not edit or run it.
- Plotly and ipywidgets outputs are kept in the file but not drawn (no bundled JS).

## Settings

Set in the plugin row of your profile: `python`, `autosave`, `maxOutputChars`, `agentCellTimeoutS`, `idleMinutes`, `approval` (`auto` | `always` | `never`).
