import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import DecisionCard from '@/components/DecisionCard'
import type { Decision, Adviser } from '@/lib/types'

export const metadata: Metadata = { title: 'Dashboard' }

export default async function DashboardPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/signin')

  const { data: decisions } = await supabase
    .from('decisions')
    .select('*')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  const decisionIds = (decisions ?? []).map((d: Decision) => d.id)

  let advisersMap: Record<string, Adviser[]> = {}
  if (decisionIds.length > 0) {
    const { data: advisers } = await supabase
      .from('advisers')
      .select('*')
      .in('decision_id', decisionIds)

    advisersMap = (advisers ?? []).reduce(
      (acc: Record<string, Adviser[]>, a: Adviser) => {
        if (!acc[a.decision_id]) acc[a.decision_id] = []
        acc[a.decision_id].push(a)
        return acc
      },
      {}
    )
  }

  const decisionList = (decisions ?? []) as Decision[]

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Your decisions</h1>
          <p className="text-gray-500 text-sm mt-1">
            {decisionList.length > 0
              ? `${decisionList.length} decision${decisionList.length !== 1 ? 's' : ''}`
              : 'No decisions yet'}
          </p>
        </div>
        <Link
          href="/decisions/new"
          className="bg-brand-blue text-white text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-brand-blue-light transition-colors"
        >
          New decision
        </Link>
      </div>

      {decisionList.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-2xl p-16 text-center">
          <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-6">
            <svg className="h-8 w-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            You have not created a decision yet.
          </h2>
          <p className="text-gray-500 mb-6 max-w-sm mx-auto text-sm leading-relaxed">
            Start with one question you would benefit from hearing five views on.
          </p>
          <Link
            href="/decisions/new"
            className="bg-brand-blue text-white text-sm font-medium px-6 py-3 rounded-xl hover:bg-brand-blue-light transition-colors inline-block"
          >
            Create your first Board of Five
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {decisionList.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              advisers={advisersMap[decision.id] ?? []}
            />
          ))}
        </div>
      )}
    </div>
  )
}
