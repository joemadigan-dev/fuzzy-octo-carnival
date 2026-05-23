import type { DecisionStatus } from '@/lib/types'
import { STATUS_LABELS } from '@/lib/types'
import Badge from './Badge'

const variantMap: Record<DecisionStatus, 'blue' | 'green' | 'gray' | 'yellow'> = {
  draft: 'gray',
  open: 'blue',
  briefing_ready: 'green',
  closed: 'gray',
  archived: 'gray',
}

export default function DecisionStatusBadge({ status }: { status: DecisionStatus }) {
  return <Badge variant={variantMap[status]}>{STATUS_LABELS[status]}</Badge>
}
