import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const runtime = 'nodejs'

async function readProviderFile(name: string) {
  const root = process.cwd()
  switch (name) {
    case 'config.py':
      return readFile(path.join(root, 'vendor/agent-remote/daemon/agentremoted/config.py'), 'utf8')
    case '__init__.py':
      return readFile(path.join(root, 'vendor/agent-remote/daemon/agentremoted/providers/__init__.py'), 'utf8')
    case 'cursor.py':
      return readFile(path.join(root, 'vendor/agent-remote/daemon/agentremoted/providers/cursor.py'), 'utf8')
    case 'antigravity.py':
      return readFile(path.join(root, 'vendor/agent-remote/daemon/agentremoted/providers/antigravity.py'), 'utf8')
    case 'antigravity_interactive.py':
      return readFile(path.join(root, 'vendor/agent-remote/daemon/agentremoted/providers/antigravity_interactive.py'), 'utf8')
    default:
      return null
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ name: string }> }
) {
  const { name } = await context.params
  const file = await readProviderFile(name)
  if (file === null) return new Response('Not found\n', { status: 404 })
  return new Response(file, {
    headers: {
      'Content-Type': 'text/x-python; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
