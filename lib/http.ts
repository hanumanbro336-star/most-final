export function json(data: unknown, status = 200, extra?: HeadersInit) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...extra,
    },
  })
}

export async function readJson<T>(request: Request) {
  try {
    return (await request.json()) as T
  } catch {
    return null
  }
}
