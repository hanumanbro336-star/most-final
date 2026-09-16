'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { CheckIcon, CopyIcon, LaptopIcon, TerminalIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

const SESSION_KEY = 'forge.v1'
const APP_ORIGIN_OVERRIDE = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, '')

type LaptopPlatform = 'windows' | 'unix'
type PairStatus = 'loading' | 'waiting' | 'claimed' | 'online' | 'expired' | 'error'

type PairSession = {
  code: string
  phoneSecret: string
  deviceId?: string
  hostname?: string
  daemonOnline?: boolean
}

type WorkerDevice = {
  id?: string
  name?: string
  online?: boolean
  daemonOnline?: boolean
}

function isPrivateOrigin(origin: string) {
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.v0.build') ||
      hostname.endsWith('.v0.app') ||
      hostname.endsWith('.vercel.run')
    )
  } catch {
    return true
  }
}

export function PairingScreen() {
  const router = useRouter()
  const [session, setSession] = useState<PairSession | null>(null)
  const [status, setStatus] = useState<PairStatus>('loading')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [appOrigin, setAppOrigin] = useState('')
  const [platform, setPlatform] = useState<LaptopPlatform>('unix')

  useEffect(() => {
    setAppOrigin(APP_ORIGIN_OVERRIDE || window.location.origin)
    setPlatform(/Windows/i.test(navigator.userAgent) ? 'windows' : 'unix')
    const existing = readSession()
    if (existing?.code && existing.phoneSecret) {
      setSession(existing)
      return
    }
    void createPair()
  }, [])

  useEffect(() => {
    if (!session?.code || !session.phoneSecret) return
    let cancelled = false

    const tick = async () => {
      const url = session.deviceId
        ? `/api/devices/${encodeURIComponent(session.deviceId)}`
        : `/api/pair?code=${encodeURIComponent(session.code)}`
      try {
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${session.phoneSecret}` },
          cache: 'no-store',
        })
        const data = await response.json()
        if (cancelled) return
        if (!response.ok) {
          if (response.status === 401 || response.status === 404) {
            localStorage.removeItem(SESSION_KEY)
            setSession(null)
            await createPair()
            return
          }
          setStatus('error')
          setError(data.error || 'Pairing status is unavailable')
          return
        }
        if (data.status === 'expired') {
          setStatus('expired')
          localStorage.removeItem(SESSION_KEY)
          return
        }
        const device = data.device as WorkerDevice | undefined
        const next: PairSession = {
          ...session,
          deviceId: device?.id || session.deviceId,
          hostname: device?.name || session.hostname,
          daemonOnline: Boolean(device?.daemonOnline),
        }
        if (JSON.stringify(next) !== JSON.stringify(session)) {
          writeSession(next)
          setSession(next)
        }
        if (device?.online) setStatus('online')
        else if (device?.id || data.status === 'claimed') setStatus('claimed')
        else setStatus('waiting')
      } catch {
        if (!cancelled) {
          setStatus('error')
          setError('Could not reach the Forge relay')
        }
      }
    }

    void tick()
    const timer = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [session])

  async function createPair() {
    setStatus('loading')
    setError('')
    try {
      const response = await fetch('/api/pair', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not create a pairing code')
      const next = { code: data.code as string, phoneSecret: data.phoneSecret as string }
      writeSession(next)
      setSession(next)
      setStatus('waiting')
    } catch (cause) {
      setStatus('error')
      setError(cause instanceof Error ? cause.message : 'Could not start pairing')
    }
  }

  async function resetPairing() {
    if (session?.deviceId && session.phoneSecret) {
      await fetch(`/api/devices/${encodeURIComponent(session.deviceId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${session.phoneSecret}` },
      }).catch(() => undefined)
    }
    localStorage.removeItem(SESSION_KEY)
    setSession(null)
    await createPair()
  }

  const command = useMemo(() => {
    if (!appOrigin || !session?.code) return ''
    if (platform === 'windows') {
      return `curl.exe -fsSL ${appOrigin}/install.cmd -o "%TEMP%\\forge-install.cmd" && call "%TEMP%\\forge-install.cmd" ${session.code}`
    }
    return `curl -fsSL ${appOrigin}/install | bash -s -- ${session.code}`
  }, [appOrigin, platform, session?.code])

  async function copyCommand() {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      return
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const connected = status === 'online'
  const privateOrigin = Boolean(appOrigin) && isPrivateOrigin(appOrigin)

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-[11px] tracking-[0.28em] text-muted-foreground">FORGE</p>
        <h1 className="text-pretty text-3xl font-medium tracking-tight">
          Open this page. Run one command. Drive the laptop.
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          No account and no inbound laptop port. The bridge makes one encrypted outbound connection.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Pairing code</p>
          <StatusBadge status={status} />
        </div>
        <p className="font-mono text-3xl tracking-[0.14em] sm:text-4xl">{session?.code || '————-————'}</p>
        <p className="text-xs text-muted-foreground">Expires in 10 minutes if unused. Each code works once.</p>
      </section>

      {privateOrigin ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Publish before installing</AlertTitle>
          <AlertDescription>
            Laptop installers cannot access a private v0 preview. Publish this project to a public HTTPS URL first.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Laptop command</p>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-muted p-1" aria-label="Laptop operating system">
              <Button size="sm" variant={platform === 'windows' ? 'secondary' : 'ghost'} onClick={() => setPlatform('windows')} aria-pressed={platform === 'windows'}>
                Windows CMD
              </Button>
              <Button size="sm" variant={platform === 'unix' ? 'secondary' : 'ghost'} onClick={() => setPlatform('unix')} aria-pressed={platform === 'unix'}>
                macOS / Linux
              </Button>
            </div>
            <Button size="sm" variant="outline" onClick={copyCommand} disabled={!command || privateOrigin}>
              {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <pre className="overflow-x-auto rounded-xl bg-card p-4 font-mono text-[12px] leading-relaxed text-foreground ring-1 ring-foreground/10">
          <code>{command || 'Creating pairing code…'}</code>
        </pre>
      </section>

      <ol className="flex flex-col gap-0">
        <Step n={1} done={Boolean(session?.code)}>Keep this tab open</Step>
        <Step n={2} done={copied || status === 'claimed' || connected} active={status === 'waiting' && !copied}>Copy the command</Step>
        <Step n={3} done={status === 'claimed' || connected} active={status === 'waiting'}>
          {platform === 'windows' ? 'Paste it in Command Prompt (cmd.exe)' : 'Paste it in a laptop terminal'}
        </Step>
        <Step n={4} done={connected} active={status === 'claimed' || status === 'waiting'} highlight>
          {connected ? `Laptop online${session?.hostname ? ` · ${session.hostname}` : ''}` : status === 'claimed' ? 'Code claimed — waiting for the bridge' : 'The laptop will connect outbound automatically'}
        </Step>
      </ol>

      {status === 'error' ? <p className="text-sm text-destructive">{error}</p> : null}
      {status === 'expired' ? <Button onClick={() => void createPair()}>Get a new code</Button> : null}

      {connected ? (
        <div className="flex flex-col gap-3">
          <Button size="lg" onClick={() => router.push('/console')}>
            <LaptopIcon data-icon="inline-start" />
            Open console
          </Button>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {session?.daemonOnline ? 'Bridge and local daemon are ready.' : 'Bridge connected; the local daemon is still starting.'}
            </p>
            <Button size="sm" variant="ghost" onClick={() => void resetPairing()}>Remove laptop</Button>
          </div>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {status === 'waiting' || status === 'claimed' ? <Spinner /> : <TerminalIcon />}
          The connected state confirms the production relay path.
        </p>
      )}
    </main>
  )
}

function StatusBadge({ status }: { status: PairStatus }) {
  if (status === 'online') return <Badge>Connected</Badge>
  if (status === 'claimed') return <Badge variant="secondary">Claimed</Badge>
  if (status === 'expired') return <Badge variant="destructive">Expired</Badge>
  if (status === 'error') return <Badge variant="destructive">Error</Badge>
  return <Badge variant="secondary">Waiting</Badge>
}

function Step({ n, children, done, active, highlight }: { n: number; children: ReactNode; done?: boolean; active?: boolean; highlight?: boolean }) {
  return (
    <li className="flex items-start gap-3 border-l border-foreground/10 py-2.5 pl-4 first:pt-0 last:pb-0">
      <span className={done ? 'mt-0.5 flex size-5 items-center justify-center rounded-full bg-primary font-mono text-[10px] text-primary-foreground' : 'mt-0.5 flex size-5 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground'}>
        {done ? <CheckIcon className="size-3" /> : n}
      </span>
      <span className={highlight && active && !done ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>{children}</span>
    </li>
  )
}

function readSession(): PairSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? (JSON.parse(raw) as PairSession) : null
  } catch {
    localStorage.removeItem(SESSION_KEY)
    return null
  }
}

function writeSession(session: PairSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}
