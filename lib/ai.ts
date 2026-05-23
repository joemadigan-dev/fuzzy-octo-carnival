import Anthropic from '@anthropic-ai/sdk'
import type { Decision, Adviser, Response } from './types'
import { buildBriefPrompt, SYSTEM_PROMPT, PROMPT_VERSION } from './prompts'

const MODEL_PROVIDER = 'anthropic'
const MODEL_NAME = 'claude-sonnet-4-6'

export interface BriefResult {
  full_brief_markdown: string
  model_provider: string
  model_name: string
  prompt_version: string
}

export async function generateDecisionBrief(
  decision: Decision,
  advisers: Adviser[],
  responses: Response[]
): Promise<BriefResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  })

  const userPrompt = buildBriefPrompt(decision, advisers, responses)

  const message = await client.messages.create({
    model: MODEL_NAME,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  })

  const content = message.content[0]
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from AI')
  }

  return {
    full_brief_markdown: content.text,
    model_provider: MODEL_PROVIDER,
    model_name: MODEL_NAME,
    prompt_version: PROMPT_VERSION,
  }
}
