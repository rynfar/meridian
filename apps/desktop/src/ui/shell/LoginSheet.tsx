import { useState } from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { useDesktop } from '../lib/desktop'
import { Button } from '../components/button'
import { Input } from '../components/controls'
import { Sheet } from '../components/overlay'

/** Every sign-in flow: Claude paste-code (HTTP or the managed CLI) and ChatGPT device code or redirect. */
export function LoginSheet() {
  const { state, run, busy } = useDesktop()
  const [code, setCode] = useState('')
  const login = state?.login
  if (!login) return null
  const finished = ['success', 'error', 'cancelled'].includes(login.phase)
  const chatgpt = login.provider === 'chatgpt'
  const waiting = login.phase === 'waiting'
  const close = () => { void run('login-code', finished ? 'dismiss' : 'cancel') }
  const message = login.phase === 'starting' ? 'Preparing your secure sign-in link…'
    : login.phase === 'cancelling' ? 'Cancelling sign-in…'
    : login.phase === 'verifying' ? 'Checking your authorization…'
    : login.phase === 'success' ? `Signed in. ${login.profile} can now serve requests.`
    : login.phase === 'error' ? 'Sign-in did not finish. Try again for a fresh link and code.'
    : login.phase === 'cancelled' ? 'Sign-in cancelled.'
    : chatgpt && login.userCode ? 'Open the page in any browser, sign in to ChatGPT and enter this code.'
    : chatgpt ? 'Sign in to ChatGPT in the browser. If the page does not return to Meridian, paste the address it ended on.'
    : `Sign in with the Claude account you want for ${login.profile}, authorize Meridian, then paste the code Claude shows.`
  const submit = () => { if (code.trim()) void run('login-code', code.trim()).then(() => setCode('')) }
  return (
    <Sheet open onClose={close} title={`${login.phase === 'success' ? 'Connected' : chatgpt ? 'Sign in to ChatGPT' : 'Sign in to Claude'} · ${login.profile}`} description={message}
      footer={finished ? <>{login.phase === 'error' ? <Button variant="subtle" disabled={busy} onClick={() => { void run(chatgpt ? 'chatgpt-connect' : 'login-profile', chatgpt ? { profile: login.profile } : login.profile) }}>Try again</Button> : null}<Button onClick={close}>Done</Button></>
        : <Button variant="subtle" onClick={close} disabled={login.phase === 'cancelling'}>Cancel sign-in</Button>}>
      {!finished ? (
        <ol className="flex flex-col gap-4 text-sm">
          <li>
            <div className="font-medium">1 · Open the sign-in page</div>
            {login.userCode ? <div className="selectable mt-2 rounded-lg bg-accent2/10 py-2 text-center font-mono text-xl font-bold tracking-wider text-accent2">{login.userCode}</div> : null}
            <Button className="mt-2" disabled={!login.url || !waiting} onClick={() => { void run('open-login') }}>{login.url ? <ExternalLink /> : <LoaderCircle className="animate-spin" />}Continue in browser</Button>
          </li>
          {!login.userCode ? (
            <li>
              <div className="font-medium">2 · {chatgpt ? 'Paste the address the sign-in tab ended on' : 'Paste the authorization code'}</div>
              <form className="mt-2 flex gap-2" onSubmit={event => { event.preventDefault(); submit() }}>
                <Input type={chatgpt ? 'text' : 'password'} autoComplete="off" aria-label={chatgpt ? 'Final address' : 'Authorization code'} value={code} disabled={!waiting} onChange={event => setCode(event.target.value)} />
                <Button type="submit" disabled={!waiting || !code.trim()}>{login.phase === 'verifying' ? 'Connecting…' : 'Connect'}</Button>
              </form>
            </li>
          ) : <li className="flex items-center gap-2 text-muted"><LoaderCircle className="size-3.5 animate-spin" />Waiting for the code to be entered…</li>}
          {login.output && waiting ? <li className="text-xs text-muted">{login.output.split('\n').slice(-2).join(' ')}</li> : null}
        </ol>
      ) : login.phase === 'error' && login.output ? (
        <details className="text-sm"><summary className="cursor-default text-accent">Technical details</summary><pre className="selectable mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-bg p-2 font-mono text-xs">{login.output}</pre></details>
      ) : null}
    </Sheet>
  )
}
