'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { CheckIcon, CopyIcon, LaptopIcon, TerminalIcon, TriangleAlertIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'

const SESSION_KEY = 'forge.v1'
const APP_URL_KEY = 'forge.appUrl'
const PUBLIC_APP_URL = 'https://clone-github-repository-three.vercel.app'
const PREVIOUS_APP_URLS = new Set(['https://zero-labs-nine.vercel.app'])

type LaptopPlatform = 'windows' | 'unix'

function normalizeOrigin(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    return new URL(withScheme).origin
  } catch {
    return ''
  }
}

// v0 preview hosts sit behind the chat's session, so an unauthenticated laptop
// gets a login page instead of the installer.
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
    return false
  }
}

type PairSession = {
  code: string
  phoneSecret: string
  deviceId?: string
  hostname?: string
  daemonOk?: boolean
}

type PairStatus = 'loading' | 'waiting' | 'claimed' | 'online' | 'expired' | 'error'

export function PairingScreen() {
  const router = useRouter()
  const [session, setSession] = useState<PairSession | null>(null)
  const [status, setStatus] = useState<PairStatus>('loading')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [origin, setOrigin] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [platform, setPlatform] = useState<LaptopPlatform>('unix')

  useEffect(() => {
    const current = window.location.origin
    setOrigin(current)
    setPlatform(/Windows/i.test(navigator.userAgent) ? 'windows' : 'unix')
    const saved = normalizeOrigin(localStorage.getItem(APP_URL_KEY) || '')
    const initialUrl = saved && !PREVIOUS_APP_URLS.has(saved) ? saved : PUBLIC_APP_URL
    setAppUrl(initialUrl)
    setUrlDraft(initialUrl)
    localStorage.setItem(APP_URL_KEY, initialUrl)
    const existing = readSession()
    if (existing?.code && existing.phoneSecret) {
      setSession(existing)
      return
    }
    void createPair(null)
  }, [])

  useEffect(() => {
    if (!session?.code || !session.phoneSecret) return
    let cancelled = false

    const tick = async () => {
      try {
        const url = session.deviceId
          ? `/api/devices/${session.deviceId}`
          : `/api/pair?code=${encodeURIComponent(session.code)}`
        const headers: HeadersInit = { Authorization: `Bearer ${session.phoneSecret}` }
        const response = await fetch(url, { headers, cache: 'no-store' })
        const data = await response.json()
        if (cancelled) return
        if (!response.ok) {
          setStatus('error')
          setError(data.error || 'Pairing failed')
          return
        }
        if (data.status === 'expired') {
          setStatus('expired')
          localStorage.removeItem(SESSION_KEY)
          return
        }
        const next: PairSession = {
          ...session,
          deviceId: data.deviceId || session.deviceId,
          hostname: data.hostname || session.hostname,
          daemonOk: Boolean(data.daemonOk),
        }
        if (data.deviceId && data.deviceId !== session.deviceId) {
          writeSession(next)
          setSession(next)
        }
        if (data.online || data.status === 'online') {
          setStatus('online')
          writeSession(next)
        } else if (data.status === 'claimed' || data.deviceId) {
          setStatus('claimed')
        } else {
          setStatus('waiting')
        }
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [session?.code, session?.phoneSecret, session?.deviceId])

  async function createPair(previous: PairSession | null) {
    try {
      const response = await fetch('/api/pair', { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not create a pairing code')
      const next = { code: data.code as string, phoneSecret: data.phoneSecret as string }
      writeSession(next)
      setSession(next)
      setStatus('waiting')
    } catch (err) {
      setStatus('error')
      setError(err instanceof Error ? err.message : 'Could not start pairing')
      if (previous) setSession(previous)
    }
  }

  const command = useMemo(() => {
    if (!appUrl || !session?.code) return ''
    if (platform === 'windows') {
      return `curl.exe -fsSL ${appUrl}/install.cmd -o "%TEMP%\\forge-install.cmd" && call "%TEMP%\\forge-install.cmd" ${session.code}`
    }
    return `curl -fsSL ${appUrl}/install -o /tmp/forge-install.sh && grep -q '^#!/usr/bin/env bash' /tmp/forge-install.sh && bash /tmp/forge-install.sh ${session.code} || echo "Installer fetch failed — is ${appUrl} public?"`
  }, [appUrl, platform, session?.code])

  function commitAppUrl() {
    const next = normalizeOrigin(urlDraft)
    if (!next) {
      setUrlDraft(appUrl)
      return
    }
    setAppUrl(next)
    setUrlDraft(next)
    localStorage.setItem(APP_URL_KEY, next)
  }

  function useCurrentOrigin() {
    setAppUrl(origin)
    setUrlDraft(origin)
    localStorage.removeItem(APP_URL_KEY)
  }

  async function copyCommand() {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
    } catch {
      /* user can still select the command */
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const connected = status === 'online'
  const privateOrigin = Boolean(appUrl) && isPrivateOrigin(appUrl)

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-8 px-6 py-10">
      <header className="flex flex-col gap-3">
        <p className="font-mono text-[11px] tracking-[0.28em] text-muted-foreground">FORGE</p>
        <h1 className="text-3xl font-medium tracking-tight text-pretty">
          Open this page. Run one command. Drive the laptop.
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          No account. The laptop dials out — no ports, no Cloudflare, no Tailscale.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Pairing code</p>
          <StatusBadge status={status} />
        </div>
        <p className="font-mono text-3xl tracking-[0.14em] sm:text-4xl">{session?.code || '————-————'}</p>
        <p className="text-xs text-muted-foreground">Expires in 10 minutes if unused. Keep this tab open.</p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">App URL</p>
          {appUrl !== origin ? (
            <Button size="sm" variant="ghost" onClick={useCurrentOrigin}>
              Use this page
            </Button>
          ) : null}
        </div>
        <Input
          value={urlDraft}
          onChange={(event) => setUrlDraft(event.target.value)}
          onBlur={commitAppUrl}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') commitAppUrl()
          }}
          spellCheck={false}
          autoComplete="off"
          aria-label="Public app URL the laptop should call"
          placeholder="https://your-app.vercel.app"
        />
        {privateOrigin ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>This URL is private</AlertTitle>
            <AlertDescription>
              The preview URL only answers while you are signed in to v0, so the laptop receives a
              login page instead of the installer. Publish the app, then paste its public URL here.
            </AlertDescription>
          </Alert>
        ) : (
          <p className="text-xs text-muted-foreground">
            The laptop calls this URL, so it has to be reachable without signing in.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Laptop command</p>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg bg-muted p-1" aria-label="Laptop operating system">
              <Button
                size="sm"
                variant={platform === 'windows' ? 'secondary' : 'ghost'}
                onClick={() => setPlatform('windows')}
                aria-pressed={platform === 'windows'}
              >
                Windows CMD
              </Button>
              <Button
                size="sm"
                variant={platform === 'unix' ? 'secondary' : 'ghost'}
                onClick={() => setPlatform('unix')}
                aria-pressed={platform === 'unix'}
              >
                macOS / Linux
              </Button>
            </div>
            <Button size="sm" variant="outline" onClick={copyCommand} disabled={!command}>
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
        <Step n={1} done={Boolean(session?.code)}>
          Keep this tab open
        </Step>
        <Step n={2} done={copied || status === 'claimed' || connected} active={status === 'waiting' && !copied}>
          Copy the command
        </Step>
        <Step n={3} done={status === 'claimed' || connected} active={status === 'waiting'}>
          {platform === 'windows' ? 'Paste it in Command Prompt (cmd.exe)' : 'Paste it in a terminal on the laptop'}
        </Step>
        <Step n={4} done={connected} active={status === 'claimed' || status === 'waiting'} highlight>
          {connected
            ? `Laptop online${session?.hostname ? ` · ${session.hostname}` : ''}`
            : status === 'claimed'
              ? 'Code claimed — waiting for the bridge heartbeat'
              : 'This line turns connected when the laptop dials out'}
        </Step>
      </ol>

      {status === 'error' ? (
        <p className="text-sm text-destructive">{error || 'Something went wrong creating the code.'}</p>
      ) : null}
      {status === 'expired' ? (
        <Button onClick={() => void createPair(null)}>Get a new code</Button>
      ) : null}

      {connected ? (
        <div className="flex flex-col gap-3">
          <Button size="lg" onClick={() => router.push('/console')}>
            <LaptopIcon data-icon="inline-start" />
            Open console
          </Button>
          <p className="text-xs text-muted-foreground">
            {session?.daemonOk
              ? 'Local daemon is up. The imported Agent Remote client will talk through this pipe.'
              : 'Pipe works. If the daemon is still booting, wait a few seconds then open the console.'}
          </p>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {status === 'waiting' || status === 'claimed' ? <Spinner /> : <TerminalIcon />}
          Step 4 is the test. When it flips, the production path is working.
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

function Step({
  n,
  children,
  done,
  active,
  highlight,
}: {
  n: number
  children: ReactNode
  done?: boolean
  active?: boolean
  highlight?: boolean
}) {
  return (
    <li className="flex items-start gap-3 border-l border-foreground/10 py-2.5 pl-4 first:pt-0 last:pb-0">
      <span
        className={
          done
            ? 'mt-0.5 flex size-5 items-center justify-center rounded-full bg-primary font-mono text-[10px] text-primary-foreground'
            : 'mt-0.5 flex size-5 items-center justify-center rounded-full bg-muted font-mono text-[10px] text-muted-foreground'
        }
      >
        {done ? <CheckIcon className="size-3" /> : n}
      </span>
      <span className={highlight && active && !done ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>
        {children}
      </span>
    </li>
  )
}

function readSession(): PairSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PairSession
  } catch {
    return null
  }
}

function writeSession(session: PairSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
}
