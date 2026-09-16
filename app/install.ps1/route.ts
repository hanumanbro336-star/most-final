import { publicOrigin } from '@/lib/crypto'
import { windowsInstallScript } from '@/lib/install-script'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const relayUrl = process.env.CLOUDFLARE_WORKER_URL
  if (!relayUrl) return new Response("throw 'Forge relay is not configured.'\n", { status: 503 })
  return new Response(windowsInstallScript(publicOrigin(request), relayUrl), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
