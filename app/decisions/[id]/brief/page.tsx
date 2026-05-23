import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import Card from '@/components/Card'
import BriefRenderer from '@/components/BriefRenderer'
import GenerateBriefButton from '@/components/GenerateBriefButton'
import PrintButton from '@/components/PrintButton'
import { formatDate } from '@/lib/utils'
import type { Decision, DecisionBrief } from '@/lib/types'

export const metadata: Metadata = { title: 'Decision Brief' }

export default async function DecisionBriefPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/signin')

  const { data: decision } = await supabase
    .from('decisions')
    .select('*')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!decision) notFound()

  const { data: briefs } = await supabase
    .from('decision_briefs')
    .select('*')
    .eq('decision_id', id)
    .order('created_at', { ascending: false })
    .limit(1)

  const { data: responseCountData } = await supabase
    .from('responses')
    .select('id', { count: 'exact', head: true })
    .eq('decision_id', id)

  const dec = decision as Decision
  const brief = briefs?.[0] as DecisionBrief | undefined
  const responseCount = responseCountData ?? 0

  if (!brief) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="mb-6">
          <Link href={`/decisions/${id}`} className="text-sm text-gray-400 hover:text-gray-600">
            ← Back to decision
          </Link>
        </div>
        <Card className="text-center py-12">
          <h1 className="text-xl font-semibold text-gray-900 mb-3">No brief yet</h1>
          <p className="text-gray-500 mb-6">Generate a decision brief from the decision page once advisers have responded.</p>
          <Link
            href={`/decisions/${id}`}
            className="text-sm font-medium text-brand-blue hover:underline"
          >
            Go to decision
          </Link>
        </Card>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      {/* Nav */}
      <div className="mb-8">
        <Link href={`/decisions/${id}`} className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
          ← {dec.title}
        </Link>
      </div>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-gray-400 uppercase tracking-widest">
            Decision Brief
          </span>
          {brief.version > 1 && (
            <span className="text-xs text-gray-400">v{brief.version}</span>
          )}
        </div>
        <h1 className="text-3xl font-semibold text-gray-900 mb-3 leading-tight">{dec.title}</h1>
        <p className="text-gray-500 mb-4">{dec.question}</p>
        <div className="flex items-center gap-4 text-sm text-gray-400 flex-wrap">
          <span>Generated {formatDate(brief.created_at)}</span>
          {brief.model_name && <span>via {brief.model_provider} / {brief.model_name}</span>}
        </div>
      </div>

      {/* Brief content */}
      {brief.full_brief_markdown ? (
        <Card padding="lg">
          <BriefRenderer markdown={brief.full_brief_markdown} />
        </Card>
      ) : (
        <Card>
          <p className="text-gray-500">Brief content not available.</p>
        </Card>
      )}

      {/* Actions */}
      <div className="mt-8 pt-8 border-t border-gray-200">
        <div className="flex flex-col sm:flex-row gap-4 items-start justify-between">
          <GenerateBriefButton
            decisionId={id}
            hasBrief={true}
            responseCount={typeof responseCount === 'number' ? responseCount : 0}
          />
          {brief.full_brief_markdown && <PrintButton />}
        </div>
      </div>
    </div>
  )
}
