import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Decision, Adviser, Response } from '@/lib/types'

export async function GET(
  _request: Request,
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

  const { data: decision, error } = await supabase
    .from('decisions')
    .select('*')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (error || !decision) {
    return NextResponse.json({ error: 'Decision not found' }, { status: 404 })
  }

  const { data: advisers } = await supabase
    .from('advisers')
    .select('*')
    .eq('decision_id', id)
    .order('created_at')

  const { data: responses } = await supabase
    .from('responses')
    .select('*')
    .eq('decision_id', id)
    .order('submitted_at')

  return NextResponse.json({
    decision: decision as Decision,
    advisers: (advisers ?? []) as Adviser[],
    responses: (responses ?? []) as Response[],
  })
}
