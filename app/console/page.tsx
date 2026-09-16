import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { ConsoleFrame } from '@/components/console-frame'

export default async function ConsolePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in')

  return <ConsoleFrame email={session.user.email} />
}
