/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['pg'],
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/share', destination: '/ar/share.html' },
        { source: '/bridge.py', destination: '/api/bridge' },
      ],
    }
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
      {
        source: '/install',
        headers: [
          { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
          {
            key: 'Cache-Control',
            value: 'public, max-age=300, must-revalidate',
          },
        ],
      },
    ]
  },
}

export default nextConfig
