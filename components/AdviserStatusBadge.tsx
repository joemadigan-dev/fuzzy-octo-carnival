import type { InviteStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

const styles: Record<InviteStatus, { dot: string; text: string; label: string }> = {
  pending: {
    dot: 'bg-gray-300',
    text: 'text-gray-500',
    label: 'Pending',
  },
  opened: {
    dot: 'bg-yellow-400',
    text: 'text-yellow-700',
    label: 'Opened',
  },
  submitted: {
    dot: 'bg-green-500',
    text: 'text-green-700',
    label: 'Submitted',
  },
  expired: {
    dot: 'bg-red-400',
    text: 'text-red-600',
    label: 'Expired',
  },
}

export default function AdviserStatusBadge({
  status,
  className,
}: {
  status: InviteStatus
  className?: string
}) {
  const style = styles[status]

  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', style.text, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', style.dot)} />
      {style.label}
    </span>
  )
}
