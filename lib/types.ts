export type DecisionType =
  | 'career'
  | 'investment'
  | 'business'
  | 'hiring'
  | 'product'
  | 'personal'
  | 'legal_regulatory'
  | 'other'

export type DecisionStatus =
  | 'draft'
  | 'open'
  | 'briefing_ready'
  | 'closed'
  | 'archived'

export type InviteStatus = 'pending' | 'opened' | 'submitted' | 'expired'

export type Recommendation =
  | 'strongly_yes'
  | 'lean_yes'
  | 'uncertain'
  | 'lean_no'
  | 'strongly_no'

export type AdviceStyle =
  | 'supportive'
  | 'challenging'
  | 'pragmatic'
  | 'risk_focused'
  | 'commercial'
  | 'personal'

export interface Decision {
  id: string
  owner_id: string
  title: string
  question: string
  context: string | null
  decision_type: DecisionType
  deadline: string | null
  status: DecisionStatus
  created_at: string
  updated_at: string
  closed_at: string | null
  final_decision: string | null
  share_summary_enabled: boolean
}

export interface Adviser {
  id: string
  decision_id: string
  name: string | null
  email: string | null
  role_label: string | null
  invite_token: string
  invite_status: InviteStatus
  created_at: string
  updated_at: string
  submitted_at: string | null
}

export interface Response {
  id: string
  adviser_id: string
  decision_id: string
  recommendation: Recommendation
  reasoning: string
  underestimated_risk: string
  change_mind_condition: string
  confidence_score: number
  recommended_next_step: string | null
  advice_style: AdviceStyle | null
  submitted_at: string
  created_at: string
  updated_at: string
}

export interface DecisionBrief {
  id: string
  decision_id: string
  version: number
  model_provider: string | null
  model_name: string | null
  prompt_version: string | null
  executive_summary: string | null
  consensus_view: string | null
  recommendation_split: Record<string, number> | null
  reasons_to_proceed: string[] | null
  reasons_to_pause: string[] | null
  underestimated_risks: string[] | null
  change_mind_factors: string[] | null
  confidence_analysis: string | null
  recommended_next_step: string | null
  suggested_decision: string | null
  caveats: string | null
  questions_to_ask: string[] | null
  full_brief_markdown: string | null
  created_at: string
}

export interface ViralEvent {
  id: string
  source_decision_id: string | null
  source_adviser_id: string | null
  event_type: string
  created_at: string
  metadata: Record<string, unknown> | null
}

export interface AdviserInput {
  name?: string
  email?: string
  role_label?: string
}

export interface CreateDecisionInput {
  title: string
  question: string
  context?: string
  decision_type: DecisionType
  deadline?: string
  advisers: AdviserInput[]
}

export interface SubmitResponseInput {
  recommendation: Recommendation
  reasoning: string
  underestimated_risk: string
  change_mind_condition: string
  confidence_score: number
  recommended_next_step?: string
  advice_style?: AdviceStyle
}

export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  strongly_yes: 'Strong yes',
  lean_yes: 'Lean yes',
  uncertain: 'Uncertain',
  lean_no: 'Lean no',
  strongly_no: 'Strong no',
}

export const DECISION_TYPE_LABELS: Record<DecisionType, string> = {
  career: 'Career',
  investment: 'Investment',
  business: 'Business',
  hiring: 'Hiring',
  product: 'Product',
  personal: 'Personal',
  legal_regulatory: 'Legal / Regulatory',
  other: 'Other',
}

export const STATUS_LABELS: Record<DecisionStatus, string> = {
  draft: 'Draft',
  open: 'Open',
  briefing_ready: 'Brief ready',
  closed: 'Closed',
  archived: 'Archived',
}
