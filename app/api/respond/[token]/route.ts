import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { validateResponse } from '@/lib/validators'
import { trackEvent } from '@/lib/analytics'
import type { SubmitResponseInput, Adviser } from '@/lib/types'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase = createAdminClient()

  // Look up adviser by token
  const { data: adviser, error: adviserError } = await supabase
    .from('advisers')
    .select('*')
    .eq('invite_token', token)
    .single()

  if (adviserError || !adviser) {
    return NextResponse.json({ error: 'Invalid or expired invitation link' }, { status: 404 })
  }

  const adv = adviser as Adviser

  // Check already submitted
  if (adv.invite_status === 'submitted') {
    return NextResponse.json({ error: 'Already submitted' }, { status: 409 })
  }

  // Check decision is still open
  const { data: decision } = await supabase
    .from('decisions')
    .select('status')
    .eq('id', adv.decision_id)
    .single()

  if (!decision || decision.status === 'closed' || decision.status === 'archived') {
    return NextResponse.json(
      { error: 'This decision is no longer accepting responses' },
      { status: 410 }
    )
  }

  let body: SubmitResponseInput
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { valid, errors } = validateResponse(body)
  if (!valid) {
    return NextResponse.json({ error: 'Validation failed', errors }, { status: 422 })
  }

  // Insert response
  const { data: response, error: responseError } = await supabase
    .from('responses')
    .insert({
      adviser_id: adv.id,
      decision_id: adv.decision_id,
      recommendation: body.recommendation,
      reasoning: body.reasoning,
      underestimated_risk: body.underestimated_risk,
      change_mind_condition: body.change_mind_condition,
      confidence_score: body.confidence_score,
      recommended_next_step: body.recommended_next_step || null,
      advice_style: body.advice_style || null,
      submitted_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (responseError || !response) {
    console.error('Response insert error:', responseError)
    return NextResponse.json({ error: 'Failed to save response' }, { status: 500 })
  }

  // Update adviser status
  await supabase
    .from('advisers')
    .update({
      invite_status: 'submitted',
      submitted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', adv.id)

  await trackEvent('adviser_response_submitted', {
    sourceDecisionId: adv.decision_id,
    sourceAdviserId: adv.id,
  })

  return NextResponse.json({ response_id: response.id })
}
