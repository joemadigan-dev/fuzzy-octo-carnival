import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import Navbar from '@/components/Navbar'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: {
    default: 'Board of Five',
    template: '%s | Board of Five',
  },
  description:
    'Make better decisions with the people you already trust. Board of Five helps you ask five trusted advisers one important question, then turns their answers into a clear decision brief.',
  openGraph: {
    title: 'Board of Five',
    description: 'Better decisions from the people you already trust.',
    type: 'website',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="bg-cream font-sans min-h-screen">
        <Navbar />
        <main>{children}</main>
        <footer className="mt-24 border-t border-gray-200 bg-white">
          <div className="max-w-7xl mx-auto px-6 py-10 flex flex-col sm:flex-row justify-between items-center gap-4 text-sm text-gray-500">
            <p>© 2026 Board of Five. Better decisions from the people you already trust.</p>
            <div className="flex gap-6">
              <a href="/privacy" className="hover:text-gray-900 transition-colors">Privacy</a>
              <a href="/terms" className="hover:text-gray-900 transition-colors">Terms</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  )
}
