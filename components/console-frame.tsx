'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const SESSION_KEY = 'forge.v1'
const PROFILE_KEY = 'agentremote.profiles'

type PairSession = {
  code: string
  phoneSecret: string
  deviceId?: string
  hostname?: string
  daemonOk?: boolean
}

export function ConsoleFrame({ email }: { email: string }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  const [online, setOnline] = useState(false)
  const [daemonOk, setDaemonOk] = useState(false)
  const [hostname, setHostname] = useState('Laptop')

  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) {
      router.replace('/')
      return
    }
    const session = JSON.parse(raw) as PairSession
    if (!session.deviceId || !session.phoneSecret) {
      router.replace('/')
      return
    }
    setHostname(session.hostname || 'Laptop')
    const origin = window.location.origin
    localStorage.setItem(
      PROFILE_KEY,
      JSON.stringify({
        profiles: [
          {
            id: session.deviceId,
            name: session.hostname || 'Laptop',
            baseUrl: `${origin}/d/${session.deviceId}`,
            token: session.phoneSecret,
            enabled: true,
          },
        ],
        settings: {},
      })
    )
    setReady(true)

    const tick = async () => {
      const response = await fetch(`/api/devices/${session.deviceId}`, {
        headers: { Authorization: `Bearer ${session.phoneSecret}` },
        cache: 'no-store',
      })
      if (!response.ok) return
      const data = await response.json()
      setOnline(Boolean(data.online))
      setDaemonOk(Boolean(data.daemonOk))
      if (data.hostname) setHostname(data.hostname)
    }
    void tick()
    const timer = setInterval(() => void tick(), 2500)
    return () => clearInterval(timer)
  }, [router])

  async function handleSignOut() {
    await authClient.signOut()
    router.replace('/sign-in')
    router.refresh()
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
        <div className="flex items-center gap-3">
          <Link href="/" className="font-mono text-[11px] tracking-[0.28em] text-muted-foreground">
            FORGE
          </Link>
          <span className="text-sm">{hostname}</span>
          <Badge variant={online ? 'default' : 'secondary'}>{online ? 'Online' : 'Offline'}</Badge>
          <Badge variant={daemonOk ? 'secondary' : 'outline'}>
            {daemonOk ? 'Daemon' : 'Daemon starting'}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden text-sm text-muted-foreground sm:inline">{email}</span>
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            Pairing
          </Link>
          <Button size="sm" variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </div>
      </header>
      <iframe
        title="Agent Remote"
        src="/ar/index.html"
        className="size-full border-0 bg-background"
      />
    </div>
  )
}
