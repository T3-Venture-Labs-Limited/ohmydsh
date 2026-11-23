// @vitest-environment node
// Guards every stock-DSH fact the keys depend on (see src/client/dom.ts), so a DSH update that changes the two cards fails
// here (and in the daily follow gate) instead of quietly breaking the keyboard answers. Everything is read from the
// installed @deepseek-ai/dsh-client-ui-approval and @deepseek-ai/dsh-client-ui-user-questions (devDependencies, pinned to the
// DSH version the set was tested with): their React sources AND their compiled bundles (what the page actually runs).
// Assertions are booleans with a message, not toContain on the text: a failure would otherwise print a megabyte of bundle.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CARD_SELECTOR, SEL } from '../src/client/dom.ts'

const require = createRequire(import.meta.url)
const pkgDir = (name: string): string => dirname(require.resolve(`${name}/package.json`))
const read = (path: string): string => readFileSync(path, 'utf8')

const approvalDir = pkgDir('@deepseek-ai/dsh-client-ui-approval')
const questionsDir = pkgDir('@deepseek-ai/dsh-client-ui-user-questions')
const shortcutsDir = pkgDir('@deepseek-ai/dsh-client-shortcuts')
const approvalSrc = read(join(approvalDir, 'src/client/ApprovalCard.tsx'))
const approvalBundle = read(join(approvalDir, 'lib/client.js'))
const questionSrc = read(join(questionsDir, 'src/client/QuestionComposer.tsx'))
const questionBundle = read(join(questionsDir, 'lib/client.js'))
const shortcutsBundle = read(join(shortcutsDir, 'lib/client.js'))

const has = (text: string, needle: string, why: string): void => { expect(text.includes(needle), why).toBe(true) }
const before = (text: string, a: string, b: string, why: string): void => {
  const i = text.indexOf(a)
  const j = text.indexOf(b)
  expect(i >= 0 && j >= 0 && i < j, why).toBe(true)
}

describe('our selectors are the ones in dom.ts', () => {
  it('names the attributes the cards carry', () => {
    expect(SEL.approval).toBe('[data-approval-key]')
    expect(SEL.question).toBe('[data-question-key]')
    expect(CARD_SELECTOR).toBe('[data-approval-key], [data-question-key]')
  })
})

describe('approval card', () => {
  it('still carries data-approval-key on its root, data-approval-scroll (focusable) on the body, and aria-busy once answering', () => {
    for (const [name, text] of [['source', approvalSrc], ['bundle', approvalBundle]] as const) {
      has(text, 'data-approval-key', `${name}: the approval card root no longer has data-approval-key`)
      has(text, 'data-approval-scroll', `${name}: the approval body no longer has data-approval-scroll`)
      has(text, 'aria-busy', `${name}: the approval card no longer sets aria-busy while answering`)
    }
    has(approvalSrc, 'tabIndex={0}', 'the approval body is no longer focusable (tabIndex 0): we focus it when the card appears')
  })

  it('still has the action row directly after the body, with Reject, Allow once and (optional) Always allow in that order', () => {
    before(approvalSrc, 'data-approval-scroll', 'css.actionRow', 'the action row no longer follows the approval body')
    const row = approvalSrc.slice(approvalSrc.indexOf('<div className={css.actionRow}>'))
    expect(row.startsWith('<div className={css.actionRow}>'), 'the approval action row (css.actionRow) is gone').toBe(true)
    before(row, 'answer(onReject)', 'answer(onAllow)', 'Reject is no longer the first approval button')
    before(row, 'answer(onAllow)', 'answer(onAlways)', 'Always allow is no longer after Allow once')
    // the buttons are direct children of the row (we read row.children), and "always" is conditional on onAlways
    expect(/<div className=\{css\.actionRow\}>\s*<Button/.test(approvalSrc), 'the approval buttons are no longer direct children of the action row').toBe(true)
    has(approvalSrc, '{onAlways !== undefined && <Button', 'Always allow is no longer offered only when onAlways is given')
    has(approvalSrc, "{t('reject')}", 'the Reject label key changed')
    has(approvalSrc, "{allowLabel ?? t('allowOnce')}", 'the Allow once label changed')
    has(approvalSrc, "{t('allowAlways')}", 'the Always allow label key changed')
  })

  it('its own Enter/Escape keys are still there (we replace them, so that "Enter never grants always" stays true)', () => {
    has(approvalSrc, "event.key === 'Enter' ? onAllow : onReject", 'DSH changed what Enter and Escape do on the approval card')
    has(approvalSrc, 'onAlways', 'the shared card no longer takes onAlways')
  })

  it('its fixed shortcut rows keep their ids, so ours (ohmydsh.keys.*) never collide', () => {
    const index = read(join(approvalDir, 'src/client/index.ts'))
    has(index, "'approval.allow'", 'the approval.allow fixed row was renamed')
    has(index, "'approval.reject'", 'the approval.reject fixed row was renamed')
  })
})

describe('question card', () => {
  it('still carries data-question-key on its root, data-question-scroll on the body and data-option-row on each option row', () => {
    for (const [name, text] of [['source', questionSrc], ['bundle', questionBundle]] as const) {
      has(text, 'data-question-key', `${name}: the question card root no longer has data-question-key`)
      has(text, 'data-question-scroll', `${name}: the question body no longer has data-question-scroll`)
      has(text, 'data-option-row', `${name}: option rows no longer carry data-option-row`)
    }
  })

  it('options are buttons with role radio (single) or checkbox (multiple) and aria-checked', () => {
    has(questionSrc, "role={question.multiSelect === true ? 'checkbox' : 'radio'}", 'the option roles changed')
    has(questionSrc, 'aria-checked={selected}', 'options no longer carry aria-checked')
    expect(/<button\s+type="button"\s+className=\{css\.option\}\s+role=/.test(questionSrc), 'options are no longer <button type="button" role=...>').toBe(true)
    has(questionSrc, 'disabled={locked}', 'options are no longer disabled when the card is locked (read-only or answering)')
    // the bundle quotes strings with backticks or double quotes depending on the build
    expect(/role:\s*question\.multiSelect\s*===\s*true\s*\?\s*[`"']checkbox[`"']\s*:\s*[`"']radio[`"']/.test(questionBundle), 'bundle: the option roles (checkbox / radio) changed').toBe(true)
    has(questionBundle, '"aria-checked":selected', 'bundle: options no longer carry aria-checked')
  })

  it('a single-select choice still moves on to the next question by itself; a multi-select one does not', () => {
    has(questionSrc, "question.multiSelect !== true && index < questions.length - 1 ? index + 1 : index", 'single-select no longer advances on choice (Enter handling assumes it does)')
    has(questionSrc, 'selected.includes(label)', 'multi-select toggling changed')
  })

  it('an option keeps handling Enter itself (we replace it to confirm the focused option)', () => {
    has(questionSrc, "if (event.key !== 'Enter') return", 'the option Enter handler changed')
  })

  it('the custom answer is still a <textarea> (Enter continues, Shift+Enter breaks a line)', () => {
    has(questionSrc, '<textarea', 'the custom answer is no longer a textarea')
    has(questionSrc, "event.key !== 'Enter' || event.shiftKey || isComposing(event)", 'the custom answer Enter handling changed')
  })

  it('the footer still has the pager (previous, i / n, next) first and the actions (Skip, then the primary Next/Submit) last', () => {
    has(questionSrc, '<footer className={css.footer}>', 'the question footer is no longer a <footer>')
    const footer = questionSrc.slice(questionSrc.indexOf('<footer className={css.footer}>'))
    before(footer, 'css.pager', 'css.feedback', 'the pager is no longer first in the footer')
    before(footer, 'css.feedback', 'css.footerActions', 'the footer actions are no longer last')
    const pager = footer.slice(footer.indexOf('css.pager'), footer.indexOf('css.feedback'))
    expect(/<button[\s\S]*?nav\.prev[\s\S]*?<span className=\{css\.progress\}>\{index \+ 1\} \/ \{questions\.length\}<\/span>[\s\S]*?<button[\s\S]*?nav\.next/.test(pager), 'the pager is no longer previous, "i / n", next').toBe(true)
    const actions = footer.slice(footer.indexOf('css.footerActions'))
    before(actions, 'onClick={skipQuestion}', 'onClick={continueFlow}', 'Skip is no longer before the primary button')
    has(actions, "t('action.skip')", 'the Skip label key changed')
    has(actions, 'variant="primary"', 'the Next/Submit button is no longer the primary one')
    expect(/<div className=\{css\.footerActions\}>\s*<Button/.test(footer), 'Skip and Next are no longer direct children of footerActions').toBe(true)
  })

  it('a card carries the same facts in the shipped bundle', () => {
    for (const word of ['footer', 'textarea', 'data-question-key']) has(questionBundle, word, `bundle: ${word} is gone`)
  })
})

describe('shortcut service', () => {
  it('still offers the three entry points we use', () => {
    for (const word of ['registerFixed', 'observeFixedInput', 'register(']) has(shortcutsBundle, word, `the shortcut service no longer has ${word}`)
    has(shortcutsBundle, 'catalog', 'the shortcut service no longer has a catalog')
  })
})
