// Settings: v2 provider key rows (OpenRouter, Replicate, Google) and the non-secret v2 settings.
// Keys go through the same DSH credentials path as the other rows (props.credentials.set); the host resolves them
// on every call, so a save only needs a re-read of GET /providers.
import { useCallback, useEffect, useState } from 'react'

const BASE = '/plugins/dsh-studio/v2'

interface ProviderInfo { id: string; configured: boolean; label?: string; keyRef?: string; getKeyUrl?: string; covers?: string }
interface V2Settings { 'replicate.pinned': string; 'hyperframes.cli': string; 'hyperframes.npx': '0' | '1' | ''; 'agent.capture': '0' | '1' | '' }

export interface CredentialsLike {
  set(ref: string, value: string): Promise<{ ok: boolean; error?: { message?: string } }>
  unset?: ((ref: string) => Promise<{ ok: boolean; error?: { message?: string } }>) | undefined
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, { credentials: 'same-origin', ...init })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message ?? body.error ?? `Request failed (${String(response.status)})`)
  return body
}

export function V2ProvidersSettings({ credentials, writable, credentialsAvailable, credentialEvents }: {
  credentials: CredentialsLike
  writable: boolean
  credentialsAvailable: boolean
  credentialEvents?: { listen(callback: () => void): () => void } | undefined
}) {
  const [providers, setProviders] = useState<ProviderInfo[] | undefined>()
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Record<string, { text: string; error: boolean }>>({})
  const [settings, setSettings] = useState<V2Settings | undefined>()
  const [pinned, setPinned] = useState('')
  const [cli, setCli] = useState('')
  const [settingsMessage, setSettingsMessage] = useState<{ text: string; error: boolean } | undefined>()
  const [hfAvailable, setHfAvailable] = useState<boolean | undefined>()

  const reloadProviders = useCallback(() => {
    void getJson<{ providers: ProviderInfo[] }>('/providers').then(r => { setProviders(r.providers.filter(p => p.keyRef !== undefined)) }, () => { setProviders([]) })
  }, [])
  useEffect(() => {
    reloadProviders()
    void getJson<{ settings: V2Settings }>('/settings').then(r => { setSettings(r.settings); setPinned(r.settings['replicate.pinned']); setCli(r.settings['hyperframes.cli']) }, () => undefined)
    void getJson<{ available: boolean }>('/hyperframes/status').then(r => { setHfAvailable(r.available) }, () => undefined)
  }, [reloadProviders])
  useEffect(() => credentialEvents?.listen(reloadProviders), [credentialEvents, reloadProviders])

  const saveKey = async (provider: ProviderInfo): Promise<void> => {
    const value = (keys[provider.id] ?? '').trim()
    if (provider.keyRef === undefined || value === '') return
    const note = (text: string, error = false): void => { setStatus(prev => ({ ...prev, [provider.id]: { text, error } })) }
    try {
      const result = await credentials.set(provider.keyRef, value)
      if (!result.ok) { note(result.error?.message ?? 'Could not save the key.', true); return }
      setKeys(prev => ({ ...prev, [provider.id]: '' }))
      note('Key saved.')
      reloadProviders()
    } catch (error) { note(error instanceof Error ? error.message : 'Could not save the key.', true) }
  }
  const removeKey = async (provider: ProviderInfo): Promise<void> => {
    if (provider.keyRef === undefined || typeof credentials.unset !== 'function') return
    try {
      const result = await credentials.unset(provider.keyRef)
      setStatus(prev => ({ ...prev, [provider.id]: { text: result.ok ? 'Key removed.' : (result.error?.message ?? 'Could not remove the key.'), error: !result.ok } }))
      reloadProviders()
    } catch { /* ignore */ }
  }
  const toggleCapture = async (on: boolean): Promise<void> => {
    setSettings(prev => (prev === undefined ? prev : { ...prev, 'agent.capture': on ? '1' : '0' }))
    try { await getJson('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'agent.capture': on ? '1' : '0' }) }) } catch (error) {
      setSettings(prev => (prev === undefined ? prev : { ...prev, 'agent.capture': on ? '0' : '1' }))
      setSettingsMessage({ text: error instanceof Error ? error.message : 'Could not save.', error: true })
    }
  }
  const saveSettings = async (): Promise<void> => {
    try {
      const r = await getJson<{ settings: V2Settings }>('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'replicate.pinned': pinned.trim(), 'hyperframes.cli': cli.trim() }) })
      setSettings(r.settings); setSettingsMessage({ text: 'Saved.', error: false })
      void getJson<{ available: boolean }>('/hyperframes/status').then(s => { setHfAvailable(s.available) }, () => undefined)
    } catch (error) { setSettingsMessage({ text: error instanceof Error ? error.message : 'Could not save.', error: true }) }
  }

  return (
    <div className="dsh-st-section">
      <span className="dsh-st-section-title">Studio providers (images and video)</span>
      {providers === undefined ? <span className="dsh-st-hint">Loading…</span> : providers.map(provider => {
        const note = status[provider.id]
        return (
          <form key={provider.id} className="dsh-st-field" onSubmit={(event) => { event.preventDefault(); void saveKey(provider) }}>
            <span className="dsh-st-label">{provider.label ?? provider.id} API key <span className="dsh-st-hint">{provider.configured ? '· configured' : '· not set'}</span></span>
            <input className="dsh-st-input" type="password" autoComplete="off" value={keys[provider.id] ?? ''} placeholder={provider.configured ? 'Key is set. Enter a new one to replace it.' : provider.keyRef}
              onChange={(event) => { setKeys(prev => ({ ...prev, [provider.id]: event.target.value })) }} disabled={!writable || !credentialsAvailable} aria-label={`${provider.label ?? provider.id} API key`} />
            <span className="dsh-st-hint">{provider.covers}{provider.getKeyUrl !== undefined ? <> · <a className="dsh-st-link" href={provider.getKeyUrl} target="_blank" rel="noopener noreferrer">Get a key</a></> : null} · stored as {provider.keyRef}; the same-named environment variable also works.</span>
            <span className="dsh-st-row-buttons">
              <button type="submit" className="dsh-st-btn-secondary" disabled={!writable || !credentialsAvailable || (keys[provider.id] ?? '').trim() === ''}>Save key</button>
              {typeof credentials.unset === 'function' && provider.configured ? <button type="button" className="dsh-st-btn-secondary" onClick={() => { void removeKey(provider) }} disabled={!writable}>Remove</button> : null}
            </span>
            {note !== undefined ? <span className={`dsh-st-status${note.error ? ' dsh-st-status-error' : ''}`} role="status">{note.text}</span> : null}
          </form>
        )
      })}
      {settings !== undefined && (
        <div className="dsh-st-field">
          <label className="dsh-st-check-row">
            <input type="checkbox" checked={settings['agent.capture'] !== '0'} onChange={(event) => { void toggleCapture(event.target.checked) }} disabled={!writable} />
            <span className="dsh-st-label">Save images and videos the agent makes in any chat to the gallery</span>
          </label>
          <span className="dsh-st-hint">Covers image_generate, video_generate and any other tool that returns an image. Each item shows which chat it came from. Turning this off only stops new items; nothing is removed.</span>
        </div>
      )}
      {settings !== undefined && (
        <form className="dsh-st-field" onSubmit={(event) => { event.preventDefault(); void saveSettings() }}>
          <label className="dsh-st-field">
            <span className="dsh-st-label">Extra Replicate models</span>
            <input className="dsh-st-input" value={pinned} onChange={(event) => { setPinned(event.target.value) }} placeholder="owner/name, owner/name" disabled={!writable} />
            <span className="dsh-st-hint">Space or comma separated slugs. They appear as generic models in the composer.</span>
          </label>
          <label className="dsh-st-field">
            <span className="dsh-st-label">HyperFrames CLI path</span>
            <input className="dsh-st-input" value={cli} onChange={(event) => { setCli(event.target.value) }} placeholder="Empty = use PATH" disabled={!writable} />
            <span className="dsh-st-hint">{hfAvailable === false ? 'HyperFrames CLI not found. Install it with: npm i -g hyperframes' : hfAvailable === true ? 'HyperFrames CLI found.' : ''}</span>
          </label>
          <span className="dsh-st-row-buttons"><button type="submit" className="dsh-st-btn-secondary" disabled={!writable}>Save</button></span>
          {settingsMessage !== undefined ? <span className={`dsh-st-status${settingsMessage.error ? ' dsh-st-status-error' : ''}`} role="status">{settingsMessage.text}</span> : null}
        </form>
      )}
    </div>
  )
}
