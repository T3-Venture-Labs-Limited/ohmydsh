/**
 * CodeMirror 6 cell editor. This module is only reached through a dynamic import, so it lands in a lazy chunk and
 * the CodeMirror modules stay off the boot path. Colours come from CSS (styles.css) and theme tokens.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
import { classHighlighter } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import type { JSX } from 'react'

export interface CodeEditorProps {
  value: string
  language: 'python' | 'markdown' | 'plain'
  readOnly: boolean
  autoFocus?: boolean
  lineNumbers?: boolean
  onChange: (value: string) => void
  /** Shift-Enter. */
  onRun: () => void
  /** Ctrl/Cmd-Enter. */
  onRunStay: () => void
  onFocus?: () => void
}

export default function CodeEditor(props: CodeEditorProps): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(props)
  latest.current = props
  const editable = useRef(new Compartment())

  useEffect(() => {
    if (host.current === null) return
    const run = (stay: boolean) => () => { (stay ? latest.current.onRunStay : latest.current.onRun)(); return true }
    const state = EditorState.create({
      doc: props.value,
      extensions: [
        props.lineNumbers === false ? [] : lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        EditorView.lineWrapping,
        props.language === 'python' ? python() : props.language === 'markdown' ? markdown() : [],
        syntaxHighlighting(classHighlighter),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([{ key: 'Shift-Enter', run: run(false) }, { key: 'Mod-Enter', run: run(true) }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
        editable.current.of([EditorView.editable.of(!props.readOnly), EditorState.readOnly.of(props.readOnly)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString())
          if (update.focusChanged && update.view.hasFocus) latest.current.onFocus?.()
        }),
      ],
    })
    const editor = new EditorView({ state, parent: host.current })
    view.current = editor
    if (props.autoFocus === true) editor.focus()
    return () => { editor.destroy(); view.current = null }
    // The editor is created once per mount; later prop changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Remote edits (the agent, another view): replace the document without losing the caret more than necessary.
  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    const current = editor.state.doc.toString()
    if (current === props.value) return
    const head = Math.min(editor.state.selection.main.head, props.value.length)
    editor.dispatch({ changes: { from: 0, to: current.length, insert: props.value }, selection: { anchor: head } })
  }, [props.value])

  useEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorView.editable.of(!props.readOnly), EditorState.readOnly.of(props.readOnly)]) })
  }, [props.readOnly])

  return <div ref={host} className="nb-editor" />
}
