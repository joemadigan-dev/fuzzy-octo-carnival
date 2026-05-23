import Link from 'next/link'
import type { Metadata } from 'next'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Adviser } from '@/lib/types'

export const metadata: Metadata = { title: 'Thank you' }

export default async function ThankYouPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  // Get adviser ID for viral tracking
  const supabase = createAdminClient()
  const { data: adviser } = await supabase
    .from('advisers')
    .select('id, decision_id')
    .eq('invite_token', token)
    .single()

  const adv = adviser as Pick<Adviser, 'id' | 'decision_id'> | null

  const signupUrl = `/signin?source=adviser_thank_you${adv ? `&adviser_id=${adv.id}&decision_id=${adv.decision_id}` : ''}`

  return (
    <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-6">
      <div className="max-w-lg w-full">
        {/* Thank you card */}
        <div className="bg-white border border-gray-200 rounded-2xl p-10 text-center mb-6">
          <div className="w-16 h-16 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <svg
              className="h-8 w-8 text-green-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-3">
            Thank you. Your advice has been submitted.
          </h1>
          <p className="text-gray-500 leading-relaxed">
            Your response has been shared with the person who invited you. You have helped them make a more informed decision.
          </p>
        </div>

        {/* Viral CTA */}
        <div className="bg-brand-blue rounded-2xl p-8 text-center">
          <h2 className="text-xl font-semibold text-white mb-3 leading-snug">
            Good decisions rarely happen in isolation.
          </h2>
          <p className="text-blue-200 mb-6 leading-relaxed text-sm">
            Create your own Board of Five and ask five trusted people about a decision you are facing.
          </p>
          <div className="space-y-3">
            <Link
              href={signupUrl}
              className="block bg-white text-brand-blue font-semibold text-sm px-6 py-3 rounded-xl hover:bg-gray-50 transition-colors"
            >
              Create my Board of Five
            </Link>
            <Link
              href="/"
              className="block text-blue-200 hover:text-white text-sm transition-colors"
            >
              Learn more
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
