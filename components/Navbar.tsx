import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import SignOutButton from './SignOutButton'

export default async function Navbar() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex justify-between h-16 items-center">
          <Link
            href={user ? '/dashboard' : '/'}
            className="text-lg font-semibold text-gray-900 tracking-tight hover:opacity-80 transition-opacity"
          >
            Board of Five
          </Link>

          <div className="flex items-center gap-6">
            {user ? (
              <>
                <Link
                  href="/dashboard"
                  className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
                >
                  Dashboard
                </Link>
                <Link
                  href="/decisions/new"
                  className="text-sm bg-brand-blue text-white px-4 py-2 rounded-lg hover:bg-brand-blue-light transition-colors font-medium"
                >
                  New decision
                </Link>
                <SignOutButton />
              </>
            ) : (
              <Link
                href="/signin"
                className="text-sm bg-brand-blue text-white px-4 py-2 rounded-lg hover:bg-brand-blue-light transition-colors font-medium"
              >
                Sign in
              </Link>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}
