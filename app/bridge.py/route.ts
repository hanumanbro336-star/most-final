import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'

export async function GET() {
  const file = await readFile(path.join(process.cwd(), 'bridge/forge_bridge.py'), 'utf8')
  return new Response(file, {
    headers: {
      'Content-Type': 'text/x-python; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}
