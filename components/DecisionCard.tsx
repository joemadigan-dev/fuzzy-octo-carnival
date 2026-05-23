import Link from 'next/link'
import type { Decision, Adviser } from '@/lib/types'
import { DECISION_TYPE_LABELS, STATUS_LABELS } from '@/lib/types'
import { formatDate, formatDeadline } from '@/lib/utils'
import DecisionStatusBadge from './DecisionStatusBadge'

interface DecisionCardProps {
  decision: Decision
  advisers: Adviser[]
}

export default function DecisionCard({ decision, advisers }: DecisionCardProps) {
  const submitted = advisers.filter((a) => a.invite_status === 'submitted').length
  const total = advisers.length

  return (
    <Link href={`/decisions/${decision.id}`} className="block group">
      <div className="bg-white border border-gray-200 rounded-xl p-6 hover:border-brand-blue hover:shadow-md transition-all duration-200">
        <div className="flex items-start justify-between gap-4 mb-3">
          <h3 className="font-semibold text-gray-900 group-hover:text-brand-blue transition-colors leading-snug">
            {decision.title}
          </h3>
          <DecisionStatusBadge status={decision.status} />
        </div>

        <p className="text-sm text-gray-500 line-clamp-2 mb-4">{decision.question}</p>

        <div className="flex items-center justify-between text-xs text-gray-500 pt-4 border-t border-gray-100">
          <div className="flex items-center gap-4">
            <span className="font-medium text-gray-700">
              {submitted}/{total > 0 ? total : 5} responses
            </span>
            <span>{DECISION_TYPE_LABELS[decision.decision_type]}</span>
          </div>
          <div className="flex items-center gap-4">
            {decision.deadline && (
              <span className="text-amber-600 font-medium">
                Due {formatDeadline(decision.deadline)}
              </span>
            )}
            <span>{formatDate(decision.created_at)}</span>
          </div>
        </div>
      </div>
    </Link>
  )
}
