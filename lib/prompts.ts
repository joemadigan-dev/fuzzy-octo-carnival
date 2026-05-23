import type { Decision, Adviser, Response } from './types'
import { RECOMMENDATION_LABELS, DECISION_TYPE_LABELS } from './types'

export const PROMPT_VERSION = '1.0'

export const SYSTEM_PROMPT = `You are an expert decision synthesis assistant.
Your task is to help a decision owner understand the advice they received from trusted human advisers.
You do not replace human judgement. You synthesize the responses, identify patterns, highlight disagreements, surface risks, and suggest practical next steps.
Be clear, structured, concise and thoughtful.
Do not invent facts. Only use the decision context and adviser responses provided.
If the decision appears to involve legal, financial, medical, employment or regulatory matters, include an appropriate caveat that the output is not professional advice.
Avoid overconfidence. Where responses are mixed or confidence is low, say so clearly.
Produce the output in markdown with clear headings.`

function formatResponse(response: Response, index: number): string {
  return `
ADVISER ${index + 1}:
- Recommendation: ${RECOMMENDATION_LABELS[response.recommendation]}
- Confidence: ${response.confidence_score}/10
- Reasoning: ${response.reasoning}
- Risk they may be underestimating: ${response.underestimated_risk}
- What would change their mind: ${response.change_mind_condition}
${response.recommended_next_step ? `- Recommended next step: ${response.recommended_next_step}` : ''}`
}

export function buildBriefPrompt(
  decision: Decision,
  advisers: Adviser[],
  responses: Response[]
): string {
  const totalYes = responses.filter(
    (r) => r.recommendation === 'strongly_yes' || r.recommendation === 'lean_yes'
  ).length
  const totalNo = responses.filter(
    (r) => r.recommendation === 'strongly_no' || r.recommendation === 'lean_no'
  ).length
  const totalUncertain = responses.filter((r) => r.recommendation === 'uncertain').length
  const avgConfidence = (
    responses.reduce((sum, r) => sum + r.confidence_score, 0) / responses.length
  ).toFixed(1)

  const formattedResponses = responses.map(formatResponse).join('\n---')

  return `Create a decision brief based on the following decision context and adviser responses.

DECISION TITLE:
${decision.title}

DECISION QUESTION:
${decision.question}

DECISION TYPE:
${DECISION_TYPE_LABELS[decision.decision_type]}

BACKGROUND CONTEXT:
${decision.context || 'No additional context provided.'}

DEADLINE:
${decision.deadline || 'Not specified'}

NUMBER OF ADVISERS INVITED:
${advisers.length}

NUMBER OF RESPONSES RECEIVED:
${responses.length}

RECOMMENDATION SUMMARY:
- Leaning yes: ${totalYes}
- Uncertain: ${totalUncertain}
- Leaning no: ${totalNo}
- Average confidence: ${avgConfidence}/10

ADVISER RESPONSES:
${formattedResponses}

Please produce a decision brief with the following sections:

## 1. Executive Summary
## 2. Consensus View
## 3. Recommendation Split
## 4. Main Reasons to Proceed
## 5. Main Reasons to Pause
## 6. Risks the Decision Owner May Be Underestimating
## 7. What Would Change the Answer
## 8. Confidence Analysis
## 9. Recommended Next Step
## 10. Suggested Decision
## 11. Caveats
## 12. Questions to Ask Before Deciding

The suggested decision should be one of:
- Proceed
- Proceed with conditions
- Pause
- Do not proceed
- Gather more information
- Mixed — judgement required

Be balanced. Highlight where adviser views conflict. Do not make the answer sound more certain than the evidence allows.`
}
