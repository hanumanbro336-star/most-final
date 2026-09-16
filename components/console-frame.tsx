'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const SESSION_KEY = 'forge.v1'
const PROFILE_KEY = 'agentremote.profiles'

type PairSession = {
  code: string
  phoneSecret: string
  deviceId?: string
  hostname?: string
}

type DeviceStatus = {
  device?: {
    name?: string
    online?: boolean
    daemonOnline?: boolean
  }
}

export function ConsoleFrame() {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [online, setOnline] = useState(false)
  const [daemonOnline, setDaemonOnline] = useState(false)
  const [hostname, setHostname] = useState('Laptop')

  useEffect(() => {
    let session: PairSession | null = null
    try {
      session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as PairSession | null
    } catch {
      localStorage.removeItem(SESSION_KEY)
    }
    if (!session?.deviceId || !session.phoneSecret) {
      router.replace('/')
      return
    }

    const activeSession = session
    setHostname(activeSession.hostname || 'Laptop')
    localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        profiles: [
          {
            id: activeSession.deviceId,
            name: activeSession.hostname || 'Laptop',
            baseUrl: `${window.location.origin}/d/${activeSession.deviceId}`,
            token: activeSession.phoneSecret,
            enabled: true,
          },
        ],
        settings: {},
      }),
    )
    setReady(true)

    const tick = async () => {
      try {
        const response = await fetch(`/api/devices/${activeSession.deviceId}`, {
          headers: { Authorization: `Bearer ${activeSession.phoneSecret}` },
          cache: 'no-store',
        })
        if (!response.ok) {
          setOnline(false)
          return
        }
        const data = (await response.json()) as DeviceStatus
        setOnline(Boolean(data.device?.online))
        setDaemonOnline(Boolean(data.device?.daemonOnline))
        if (data.device?.name) setHostname(data.device.name)
      } catch {
        setOnline(false)
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 2500)
    return () => window.clearInterval(timer)
  }, [router])

  async function resetPairing() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as PairSession | null
      if (session?.deviceId && session.phoneSecret) {
        await fetch(`/api/devices/${encodeURIComponent(session.deviceId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${session.phoneSecret}` },
        })
      }
    } catch {
      // Local cleanup still prevents this browser from reusing the credential.
    }
    localStorage.removeItem(SESSION_KEY)
    localStorage.removeItem(PROFILE_KEY)
    router.replace('/')
  }

  if (!ready) {
    return (
      <main className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Loading console…
      </main>
    )
  }

  return (
    <div className="flex h-svh flex-col bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-foreground/10 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/" className="shrink-0 font-mono text-[11px] tracking-[0.28em] text-muted-foreground">
            FORGE
          </Link>
          <span className="truncate text-sm">{hostname}</span>
          <Badge variant={online ? 'default' : 'secondary'}>{online ? 'Online' : 'Offline'}</Badge>
          <Badge className="hidden sm:inline-flex" variant={daemonOnline ? 'secondary' : 'outline'}>
            {daemonOnline ? 'Daemon ready' : 'Daemon unavailable'}
          </Badge>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            Pairing
          </Link>
          <Button size="sm" variant="outline" onClick={resetPairing}>
            Reset
          </Button>
        </div>
      </header>
      <iframe title="Agent Remote" src="/ar/index.html" className="size-full border-0 bg-background" />
    </div>
  )
}
