import { publicOrigin } from '@/lib/crypto'
import { unixInstallScript } from '@/lib/install-script'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  return new Response(unixInstallScript(publicOrigin(request)), {
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Content-Disposition': 'inline; filename="forge-install.sh"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
