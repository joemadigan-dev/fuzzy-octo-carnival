import { createAdminClient } from './supabase/admin'

export type EventType =
  | 'user_signed_up'
  | 'decision_created'
  | 'adviser_link_copied'
  | 'adviser_link_opened'
  | 'adviser_response_submitted'
  | 'decision_brief_generated'
  | 'adviser_clicked_create_own'
  | 'decision_closed'

export async function trackEvent(
  eventType: EventType,
  options: {
    sourceDecisionId?: string
    sourceAdviserId?: string
    metadata?: Record<string, unknown>
  } = {}
) {
  try {
    const supabase = createAdminClient()
    await supabase.from('viral_events').insert({
      event_type: eventType,
      source_decision_id: options.sourceDecisionId ?? null,
      source_adviser_id: options.sourceAdviserId ?? null,
      metadata: options.metadata ?? null,
    })
  } catch {
    // Analytics failures should never break the main flow
  }
}
