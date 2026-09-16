import { publicOrigin } from '@/lib/crypto'
import { windowsCmdInstallScript } from '@/lib/install-script'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  return new Response(windowsCmdInstallScript(publicOrigin(request)), {
    headers: {
      'Content-Type': 'application/x-bat; charset=utf-8',
      'Content-Disposition': 'inline; filename="forge-install.cmd"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
