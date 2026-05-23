import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import Card from '@/components/Card'
import RecommendationBadge from '@/components/RecommendationBadge'
import ConfidenceScore from '@/components/ConfidenceScore'
import AdviserStatusBadge from '@/components/AdviserStatusBadge'
import DecisionStatusBadge from '@/components/DecisionStatusBadge'
import ProgressBar from '@/components/ProgressBar'
import CopyButton from '@/components/CopyButton'
import GenerateBriefButton from '@/components/GenerateBriefButton'
import { DECISION_TYPE_LABELS } from '@/lib/types'
import { formatDate, formatDeadline } from '@/lib/utils'
import type { Decision, Adviser, Response, DecisionBrief } from '@/lib/types'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase.from('decisions').select('title').eq('id', id).single()
  return { title: data?.title ?? 'Decision' }
}

export default async function DecisionDetailPage({
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

  const { data: advisers } = await supabase
    .from('advisers')
    .select('*')
    .eq('decision_id', id)
    .order('created_at')

  const { data: responses } = await supabase
    .from('responses')
    .select('*')
    .eq('decision_id', id)
    .order('submitted_at')

  const { data: latestBrief } = await supabase
    .from('decision_briefs')
    .select('id')
    .eq('decision_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const dec = decision as Decision
  const adviserList = (advisers ?? []) as Adviser[]
  const responseList = (responses ?? []) as Response[]
  const submittedCount = adviserList.filter((a) => a.invite_status === 'submitted').length
  const hasBrief = !!latestBrief

  const responsesByAdviser = responseList.reduce(
    (acc: Record<string, Response>, r) => {
      acc[r.adviser_id] = r
      return acc
    },
    {}
  )

  const MAX_SLOTS = 5

  return (
    <div className="max-w-5xl mx-auto px-6 py-12 space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <Link href="/dashboard" className="text-sm text-gray-400 hover:text-gray-600 transition-colors">
              ← Dashboard
            </Link>
          </div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-2">{dec.title}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            <DecisionStatusBadge status={dec.status} />
            <span className="text-sm text-gray-500">{DECISION_TYPE_LABELS[dec.decision_type]}</span>
            {dec.deadline && (
              <span className="text-sm text-amber-600 font-medium">
                Due {formatDeadline(dec.deadline)}
              </span>
            )}
            <span className="text-sm text-gray-400">Created {formatDate(dec.created_at)}</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left: Decision info + AI brief */}
        <div className="lg:col-span-2 space-y-6">
          {/* Decision summary */}
          <Card>
            <h2 className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-4">
              Decision question
            </h2>
            <p className="text-gray-900 leading-relaxed font-medium mb-4">{dec.question}</p>
            {dec.context && (
              <>
                <h2 className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-2">
                  Context
                </h2>
                <p className="text-gray-600 leading-relaxed text-sm whitespace-pre-wrap">
                  {dec.context}
                </p>
              </>
            )}
          </Card>

          {/* Responses */}
          {responseList.length > 0 && (
            <div className="space-y-4">
              <h2 className="font-semibold text-gray-900">
                Adviser responses
                <span className="ml-2 text-sm font-normal text-gray-500">
                  ({responseList.length})
                </span>
              </h2>
              {adviserList
                .filter((a) => a.invite_status === 'submitted')
                .map((adviser, index) => {
                  const response = responsesByAdviser[adviser.id]
                  if (!response) return null
                  return (
                    <Card key={adviser.id}>
                      <div className="flex items-start justify-between gap-4 mb-4">
                        <div>
                          <p className="font-semibold text-gray-900">
                            {adviser.name ?? `Adviser ${index + 1}`}
                          </p>
                          {adviser.role_label && (
                            <p className="text-sm text-gray-500">{adviser.role_label}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 flex-shrink-0">
                          <RecommendationBadge recommendation={response.recommendation} />
                          <ConfidenceScore score={response.confidence_score} />
                        </div>
                      </div>

                      <div className="space-y-4">
                        <div>
                          <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1.5">
                            Reasoning
                          </p>
                          <p className="text-sm text-gray-700 leading-relaxed">{response.reasoning}</p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1.5">
                            Risk they may be underestimating
                          </p>
                          <p className="text-sm text-gray-700 leading-relaxed">
                            {response.underestimated_risk}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1.5">
                            What would change their mind
                          </p>
                          <p className="text-sm text-gray-700 leading-relaxed">
                            {response.change_mind_condition}
                          </p>
                        </div>
                        {response.recommended_next_step && (
                          <div>
                            <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1.5">
                              Recommended next step
                            </p>
                            <p className="text-sm text-gray-700 leading-relaxed">
                              {response.recommended_next_step}
                            </p>
                          </div>
                        )}
                      </div>
                    </Card>
                  )
                })}
            </div>
          )}

          {/* AI Brief generation */}
          <Card>
            <h2 className="font-semibold text-gray-900 mb-2">Decision brief</h2>
            {responseList.length === 0 ? (
              <p className="text-sm text-gray-500">
                You can generate a brief once at least one adviser has responded. For best results, wait for three or more.
              </p>
            ) : (
              <GenerateBriefButton
                decisionId={dec.id}
                hasBrief={hasBrief}
                responseCount={responseList.length}
              />
            )}
          </Card>
        </div>

        {/* Right: Adviser panel */}
        <div className="space-y-6">
          <div>
            <h2 className="font-semibold text-gray-900 mb-1">Adviser panel</h2>
            <ProgressBar
              current={submittedCount}
              total={adviserList.length > 0 ? adviserList.length : MAX_SLOTS}
              className="mb-4"
            />

            <div className="space-y-3">
              {adviserList.map((adviser, index) => (
                <div
                  key={adviser.id}
                  className="bg-white border border-gray-200 rounded-xl p-4"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">
                        {adviser.name ?? `Adviser ${index + 1}`}
                      </p>
                      {adviser.email && (
                        <p className="text-xs text-gray-500 truncate">{adviser.email}</p>
                      )}
                      {adviser.role_label && (
                        <p className="text-xs text-gray-400 truncate">{adviser.role_label}</p>
                      )}
                    </div>
                    <AdviserStatusBadge status={adviser.invite_status} />
                  </div>
                  {adviser.submitted_at && (
                    <p className="text-xs text-gray-400 mb-2">
                      Submitted {formatDate(adviser.submitted_at)}
                    </p>
                  )}
                  {adviser.invite_status !== 'submitted' && (
                    <CopyButton
                      text={`${appUrl}/respond/${adviser.invite_token}`}
                      label="Copy invite link"
                    />
                  )}
                </div>
              ))}

              {/* Empty slots */}
              {Array.from({ length: Math.max(0, MAX_SLOTS - adviserList.length) }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className="border border-dashed border-gray-200 rounded-xl p-4 flex items-center gap-3"
                >
                  <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center flex-shrink-0">
                    <span className="text-xs text-gray-400">{adviserList.length + i + 1}</span>
                  </div>
                  <span className="text-sm text-gray-400">Empty slot</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
