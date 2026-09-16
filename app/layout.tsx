import type { Metadata, Viewport } from 'next'
import { Analytics } from '@vercel/analytics/next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Forge',
  description:
    'Visit the site, run one command on your laptop, control Claude Code from your phone. No signup.',
  generator: 'v0.app',
  applicationName: 'Forge',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#111113',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-svh antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
