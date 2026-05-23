interface ConfidenceScoreProps {
  score: number
  showBar?: boolean
}

export default function ConfidenceScore({ score, showBar = true }: ConfidenceScoreProps) {
  const percentage = (score / 10) * 100
  const color =
    score >= 8
      ? 'bg-green-500'
      : score >= 6
        ? 'bg-blue-500'
        : score >= 4
          ? 'bg-yellow-500'
          : 'bg-red-500'

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-gray-900 tabular-nums">
        {score}<span className="text-gray-400 font-normal">/10</span>
      </span>
      {showBar && (
        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden max-w-[80px]">
          <div
            className={`h-full rounded-full transition-all ${color}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
    </div>
  )
}
