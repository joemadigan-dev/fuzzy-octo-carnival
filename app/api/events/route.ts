import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(request: Request) {
  let body: {
    event_type: string
    source_decision_id?: string
    source_adviser_id?: string
    metadata?: Record<string, unknown>
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!body.event_type) {
    return NextResponse.json({ error: 'event_type is required' }, { status: 400 })
  }

  const supabase = createAdminClient()

  const { error } = await supabase.from('viral_events').insert({
    event_type: body.event_type,
    source_decision_id: body.source_decision_id ?? null,
    source_adviser_id: body.source_adviser_id ?? null,
    metadata: body.metadata ?? null,
  })

  if (error) {
    return NextResponse.json({ error: 'Failed to record event' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
