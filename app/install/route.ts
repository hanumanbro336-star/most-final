import { publicOrigin } from '@/lib/crypto'
import { installScript } from '@/lib/install-script'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const script = installScript(publicOrigin(request))
  return new Response(script, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
