import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { validateDecision } from '@/lib/validators'
import { generateInviteToken } from '@/lib/tokens'
import { trackEvent } from '@/lib/analytics'
import type { CreateDecisionInput } from '@/lib/types'

export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  let body: CreateDecisionInput
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { valid, errors } = validateDecision(body)
  if (!valid) {
    return NextResponse.json({ error: 'Validation failed', errors }, { status: 422 })
  }

  const admin = createAdminClient()

  // Create decision
  const { data: decision, error: decisionError } = await admin
    .from('decisions')
    .insert({
      owner_id: user.id,
      title: body.title.trim(),
      question: body.question.trim(),
      context: body.context?.trim() || null,
      decision_type: body.decision_type,
      deadline: body.deadline || null,
      status: 'open',
    })
    .select()
    .single()

  if (decisionError || !decision) {
    console.error('Decision creation error:', decisionError)
    return NextResponse.json({ error: 'Failed to create decision' }, { status: 500 })
  }

  // Create advisers with tokens
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const adviserLinks: { adviser_id: string; name: string | null; response_url: string }[] = []

  const advisersToCreate = (body.advisers ?? []).slice(0, 5)

  if (advisersToCreate.length > 0) {
    const adviserInserts = advisersToCreate.map((a) => ({
      decision_id: decision.id,
      name: a.name || null,
      email: a.email || null,
      role_label: a.role_label || null,
      invite_token: generateInviteToken(),
      invite_status: 'pending',
    }))

    const { data: createdAdvisers, error: adviserError } = await admin
      .from('advisers')
      .insert(adviserInserts)
      .select()

    if (adviserError) {
      console.error('Adviser creation error:', adviserError)
      // Decision was created — return partial success
    } else {
      for (const adv of createdAdvisers ?? []) {
        adviserLinks.push({
          adviser_id: adv.id,
          name: adv.name,
          response_url: `${appUrl}/respond/${adv.invite_token}`,
        })
      }
    }
  }

  await trackEvent('decision_created', {
    sourceDecisionId: decision.id,
    metadata: { adviser_count: adviserLinks.length },
  })

  return NextResponse.json({
    decision_id: decision.id,
    adviser_links: adviserLinks,
  })
}
