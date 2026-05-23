import type { Metadata } from 'next'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Adviser, Decision } from '@/lib/types'
import { DECISION_TYPE_LABELS } from '@/lib/types'
import { formatDate } from '@/lib/utils'
import ResponseForm from '@/components/ResponseForm'

export const metadata: Metadata = { title: 'Submit advice' }

export default async function RespondPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const supabase = createAdminClient()

  // Look up adviser by token
  const { data: adviser, error } = await supabase
    .from('advisers')
    .select('*')
    .eq('invite_token', token)
    .single()

  if (error || !adviser) {
    return (
      <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 bg-red-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <svg className="h-8 w-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            This invitation link is invalid or has expired.
          </h1>
          <p className="text-gray-500 text-sm">
            Please check the link you received, or ask the decision owner to send a new one.
          </p>
        </div>
      </div>
    )
  }

  const adv = adviser as Adviser

  // Check if already submitted
  if (adv.invite_status === 'submitted') {
    return (
      <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center">
          <div className="w-16 h-16 bg-green-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <svg className="h-8 w-8 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            Your advice has already been submitted.
          </h1>
          <p className="text-gray-500 text-sm">Thank you for helping with this decision.</p>
        </div>
      </div>
    )
  }

  // Check if decision is still accepting responses
  const { data: decision } = await supabase
    .from('decisions')
    .select('*')
    .eq('id', adv.decision_id)
    .single()

  if (!decision || decision.status === 'closed' || decision.status === 'archived') {
    return (
      <div className="min-h-[calc(100vh-64px)] flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            This decision is no longer accepting responses.
          </h1>
          <p className="text-gray-500 text-sm">The decision owner has closed this decision.</p>
        </div>
      </div>
    )
  }

  const dec = decision as Decision

  // Mark as opened if still pending
  if (adv.invite_status === 'pending') {
    await supabase
      .from('advisers')
      .update({ invite_status: 'opened', updated_at: new Date().toISOString() })
      .eq('id', adv.id)
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <p className="text-sm font-medium text-brand-blue uppercase tracking-widest mb-3">
          Board of Five
        </p>
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          You have been invited to advise on a decision.
        </h1>
        <p className="text-gray-500 text-sm">
          Your response will be shared only with the person who invited you.
        </p>
      </div>

      {/* Decision context */}
      <div className="bg-white border border-gray-200 rounded-2xl p-6 mb-8">
        <div className="flex items-center gap-3 mb-4">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-widest">
            {DECISION_TYPE_LABELS[dec.decision_type]} decision
          </span>
          {dec.deadline && (
            <span className="text-xs text-amber-600 font-medium">
              Decision by {formatDate(dec.deadline)}
            </span>
          )}
        </div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">{dec.title}</h2>
        <div className="space-y-3">
          <div>
            <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1">
              The question
            </p>
            <p className="text-gray-700 leading-relaxed">{dec.question}</p>
          </div>
          {dec.context && (
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1">
                Background
              </p>
              <p className="text-gray-600 text-sm leading-relaxed whitespace-pre-wrap">
                {dec.context}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Reassurance */}
      <div className="flex items-start gap-3 text-sm text-gray-500 mb-8 bg-gray-50 border border-gray-200 rounded-xl px-4 py-3">
        <svg className="h-4 w-4 mt-0.5 text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <span>
          Your response will be shared with the person who invited you. Other advisers will not see your response.
        </span>
      </div>

      {/* Response form */}
      <ResponseForm token={token} adviserId={adv.id} />
    </div>
  )
}
