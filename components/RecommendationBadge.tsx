import type { Recommendation } from '@/lib/types'
import { RECOMMENDATION_LABELS } from '@/lib/types'
import { cn } from '@/lib/utils'

interface RecommendationBadgeProps {
  recommendation: Recommendation
  className?: string
}

const styles: Record<Recommendation, string> = {
  strongly_yes: 'bg-green-100 text-green-800 border-green-200',
  lean_yes: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  uncertain: 'bg-yellow-50 text-yellow-700 border-yellow-200',
  lean_no: 'bg-orange-50 text-orange-700 border-orange-200',
  strongly_no: 'bg-red-100 text-red-800 border-red-200',
}

export default function RecommendationBadge({
  recommendation,
  className,
}: RecommendationBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-3 py-1 rounded-full text-sm font-medium border',
        styles[recommendation],
        className
      )}
    >
      {RECOMMENDATION_LABELS[recommendation]}
    </span>
  )
}
