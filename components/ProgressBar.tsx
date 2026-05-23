interface ProgressBarProps {
  current: number
  total: number
  className?: string
}

export default function ProgressBar({ current, total, className }: ProgressBarProps) {
  const percentage = total > 0 ? Math.min((current / total) * 100, 100) : 0

  return (
    <div className={className}>
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-sm text-gray-600">
          {current} of {total} responded
        </span>
        <span className="text-sm font-medium text-gray-900">{Math.round(percentage)}%</span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-brand-blue rounded-full transition-all duration-500"
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  )
}
