import { publicOrigin } from '@/lib/crypto'
import { pythonInstallScript } from '@/lib/install-script'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  return new Response(pythonInstallScript(publicOrigin(request)), {
    headers: {
      'Content-Type': 'text/x-python; charset=utf-8',
      'Content-Disposition': 'inline; filename="forge-install.py"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
