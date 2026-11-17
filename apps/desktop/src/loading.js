'use strict'
const $ = (id) => document.getElementById(id)
window.ohmydsh.onProgress((p) => {
  $('failed').hidden = true; $('working').hidden = false
  $('step').textContent = p.step || 'Starting…'
  $('detail').textContent = p.detail || ''
  if (typeof p.fraction === 'number') $('fill').style.width = `${Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}%`
})
window.ohmydsh.onError((e) => {
  $('working').hidden = true; $('failed').hidden = false
  $('etitle').textContent = e.title || 'Something went wrong'
  $('emsg').textContent = e.message || ''
  $('elog').hidden = !e.log
  $('elog').textContent = e.log || ''
})
$('retry').addEventListener('click', () => window.ohmydsh.retry())
$('log').addEventListener('click', () => window.ohmydsh.openLog())
$('quit').addEventListener('click', () => window.ohmydsh.quit())
