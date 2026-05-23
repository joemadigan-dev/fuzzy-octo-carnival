import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateDecisionBrief } from '@/lib/ai'
import { trackEvent } from '@/lib/analytics'
import type { Decision, Adviser, Response, DecisionBrief } from '@/lib/types'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Verify ownership
  const { data: decision, error: decisionError } = await supabase
    .from('decisions')
    .select('*')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (decisionError || !decision) {
    return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
  }

  // Get advisers and responses
  const { data: advisers } = await supabase
    .from('advisers')
    .select('*')
    .eq('decision_id', id)

  const { data: responses } = await supabase
    .from('responses')
    .select('*')
    .eq('decision_id', id)

  const responseList = (responses ?? []) as Response[]

  if (responseList.length === 0) {
    return NextResponse.json(
      { error: 'No responses yet. At least one adviser must respond before generating a brief.' },
      { status: 422 }
    )
  }

  // Get current version number
  const admin = createAdminClient()
  const { data: existingBriefs } = await admin
    .from('decision_briefs')
    .select('version')
    .eq('decision_id', id)
    .order('version', { ascending: false })
    .limit(1)

  const nextVersion = existingBriefs?.[0]?.version ? existingBriefs[0].version + 1 : 1

  // Generate brief via AI
  let briefResult
  try {
    briefResult = await generateDecisionBrief(
      decision as Decision,
      (advisers ?? []) as Adviser[],
      responseList
    )
  } catch (err) {
    console.error('AI brief generation error:', err)
    return NextResponse.json(
      { error: 'We could not generate the decision brief. Please try again.' },
      { status: 500 }
    )
  }

  // Store the brief
  const { data: savedBrief, error: saveError } = await admin
    .from('decision_briefs')
    .insert({
      decision_id: id,
      version: nextVersion,
      model_provider: briefResult.model_provider,
      model_name: briefResult.model_name,
      prompt_version: briefResult.prompt_version,
      full_brief_markdown: briefResult.full_brief_markdown,
    })
    .select()
    .single()

  if (saveError || !savedBrief) {
    console.error('Brief save error:', saveError)
    return NextResponse.json({ error: 'Failed to save decision brief' }, { status: 500 })
  }

  // Update decision status
  await admin
    .from('decisions')
    .update({ status: 'briefing_ready', updated_at: new Date().toISOString() })
    .eq('id', id)

  await trackEvent('decision_brief_generated', {
    sourceDecisionId: id,
    metadata: { version: nextVersion, response_count: responseList.length },
  })

  return NextResponse.json({
    brief_id: savedBrief.id,
    full_brief_markdown: savedBrief.full_brief_markdown,
  })
}
