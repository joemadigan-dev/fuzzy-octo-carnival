import type { CreateDecisionInput, SubmitResponseInput } from './types'

export interface ValidationResult {
  valid: boolean
  errors: Record<string, string>
}

export function validateDecision(input: Partial<CreateDecisionInput>): ValidationResult {
  const errors: Record<string, string> = {}

  if (!input.title || input.title.trim().length < 5) {
    errors.title = 'Title must be at least 5 characters'
  }

  if (!input.question || input.question.trim().length < 10) {
    errors.question = 'Question must be at least 10 characters'
  }

  if (input.context && input.context.length > 10000) {
    errors.context = 'Context must be under 10,000 characters'
  }

  if (!input.decision_type) {
    errors.decision_type = 'Please select a decision type'
  }

  if (input.advisers && input.advisers.length > 5) {
    errors.advisers = 'Maximum of 5 advisers allowed'
  }

  return { valid: Object.keys(errors).length === 0, errors }
}

export function validateResponse(input: Partial<SubmitResponseInput>): ValidationResult {
  const errors: Record<string, string> = {}

  if (!input.recommendation) {
    errors.recommendation = 'Please select a recommendation'
  }

  if (!input.reasoning || input.reasoning.trim().length < 20) {
    errors.reasoning = 'Reasoning must be at least 20 characters'
  }

  if (!input.underestimated_risk || input.underestimated_risk.trim().length < 10) {
    errors.underestimated_risk = 'Please describe the risk in at least 10 characters'
  }

  if (!input.change_mind_condition || input.change_mind_condition.trim().length < 10) {
    errors.change_mind_condition = 'Please answer in at least 10 characters'
  }

  if (
    input.confidence_score === undefined ||
    input.confidence_score < 1 ||
    input.confidence_score > 10
  ) {
    errors.confidence_score = 'Confidence score must be between 1 and 10'
  }

  return { valid: Object.keys(errors).length === 0, errors }
}
