'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from './Button'
import type { Recommendation } from '@/lib/types'
import { RECOMMENDATION_LABELS } from '@/lib/types'

interface ResponseFormProps {
  token: string
  adviserId: string
}

const RECOMMENDATIONS: { value: Recommendation; description: string }[] = [
  { value: 'strongly_yes', description: 'I am confident they should proceed' },
  { value: 'lean_yes', description: 'I lean towards proceeding, with some caveats' },
  { value: 'uncertain', description: 'I genuinely do not know — more information needed' },
  { value: 'lean_no', description: 'I lean against, but could be persuaded otherwise' },
  { value: 'strongly_no', description: 'I would not proceed in the current circumstances' },
]

export default function ResponseForm({ token, adviserId }: ResponseFormProps) {
  const router = useRouter()

  const [recommendation, setRecommendation] = useState<Recommendation | ''>('')
  const [reasoning, setReasoning] = useState('')
  const [underestimatedRisk, setUnderestimatedRisk] = useState('')
  const [changeMindCondition, setChangeMindCondition] = useState('')
  const [nextStep, setNextStep] = useState('')
  const [confidenceScore, setConfidenceScore] = useState(7)
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const newErrors: Record<string, string> = {}
    if (!recommendation) newErrors.recommendation = 'Please select a recommendation'
    if (!reasoning.trim() || reasoning.trim().length < 20)
      newErrors.reasoning = 'Please provide at least 20 characters of reasoning'
    if (!underestimatedRisk.trim() || underestimatedRisk.trim().length < 10)
      newErrors.underestimated_risk = 'Please describe a risk in at least 10 characters'
    if (!changeMindCondition.trim() || changeMindCondition.trim().length < 10)
      newErrors.change_mind_condition = 'Please answer in at least 10 characters'

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    setLoading(true)

    try {
      const res = await fetch(`/api/respond/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recommendation,
          reasoning: reasoning.trim(),
          underestimated_risk: underestimatedRisk.trim(),
          change_mind_condition: changeMindCondition.trim(),
          confidence_score: confidenceScore,
          recommended_next_step: nextStep.trim() || undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        setErrors({ general: data.error || 'Something went wrong' })
        return
      }

      router.push(`/respond/${token}/thank-you`)
    } catch {
      setErrors({ general: 'Something went wrong. Please try again.' })
    } finally {
      setLoading(false)
    }
  }

  const textareaClass =
    'w-full px-4 py-3 border border-gray-300 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-transparent transition-shadow text-sm resize-none'
  const labelClass = 'block text-sm font-semibold text-gray-900 mb-1.5'
  const helperClass = 'text-xs text-gray-400 mt-1'
  const errorClass = 'mt-1 text-xs text-red-600'

  return (
    <form onSubmit={handleSubmit} className="space-y-8">
      {/* Recommendation */}
      <div>
        <label className={labelClass}>Your recommendation</label>
        <p className={helperClass}>What is your instinctive recommendation?</p>
        <div className="mt-3 space-y-2">
          {RECOMMENDATIONS.map((r) => (
            <label
              key={r.value}
              className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-all ${
                recommendation === r.value
                  ? 'border-brand-blue bg-blue-50'
                  : 'border-gray-200 bg-white hover:border-gray-300'
              }`}
            >
              <input
                type="radio"
                name="recommendation"
                value={r.value}
                checked={recommendation === r.value}
                onChange={() => setRecommendation(r.value)}
                className="mt-0.5 accent-brand-blue"
              />
              <div>
                <span className="font-medium text-sm text-gray-900">
                  {RECOMMENDATION_LABELS[r.value]}
                </span>
                <p className="text-xs text-gray-500 mt-0.5">{r.description}</p>
              </div>
            </label>
          ))}
        </div>
        {errors.recommendation && <p className={errorClass}>{errors.recommendation}</p>}
      </div>

      {/* Confidence */}
      <div>
        <label className={labelClass}>
          Confidence score:{' '}
          <span className="text-brand-blue">{confidenceScore}/10</span>
        </label>
        <p className={helperClass}>
          1 means very uncertain. 10 means very confident in your recommendation.
        </p>
        <div className="mt-3 flex items-center gap-4">
          <span className="text-xs text-gray-400 w-8">1</span>
          <input
            type="range"
            min="1"
            max="10"
            value={confidenceScore}
            onChange={(e) => setConfidenceScore(Number(e.target.value))}
            className="flex-1 accent-brand-blue"
          />
          <span className="text-xs text-gray-400 w-8 text-right">10</span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-xs text-gray-400">Very uncertain</span>
          <span className="text-xs text-gray-400">Very confident</span>
        </div>
      </div>

      {/* Reasoning */}
      <div>
        <label className={labelClass}>Your reasoning</label>
        <p className={helperClass}>Why do you see it this way?</p>
        <textarea
          value={reasoning}
          onChange={(e) => setReasoning(e.target.value)}
          placeholder="Share your thinking, experience and perspective..."
          rows={4}
          className={`${textareaClass} mt-2`}
        />
        {errors.reasoning && <p className={errorClass}>{errors.reasoning}</p>}
      </div>

      {/* Underestimated risk */}
      <div>
        <label className={labelClass}>What risk might they be underestimating?</label>
        <p className={helperClass}>What could go wrong, or what are they not giving enough weight to?</p>
        <textarea
          value={underestimatedRisk}
          onChange={(e) => setUnderestimatedRisk(e.target.value)}
          placeholder="What is the most important downside or risk they should consider?"
          rows={3}
          className={`${textareaClass} mt-2`}
        />
        {errors.underestimated_risk && <p className={errorClass}>{errors.underestimated_risk}</p>}
      </div>

      {/* Change mind */}
      <div>
        <label className={labelClass}>What would change your mind?</label>
        <p className={helperClass}>What new information, condition or evidence would shift your recommendation?</p>
        <textarea
          value={changeMindCondition}
          onChange={(e) => setChangeMindCondition(e.target.value)}
          placeholder="What would make you more or less confident in the other direction?"
          rows={3}
          className={`${textareaClass} mt-2`}
        />
        {errors.change_mind_condition && (
          <p className={errorClass}>{errors.change_mind_condition}</p>
        )}
      </div>

      {/* Next step (optional) */}
      <div>
        <label className={labelClass}>
          Recommended next step{' '}
          <span className="font-normal text-gray-400">(optional)</span>
        </label>
        <p className={helperClass}>What should they do next before making the decision?</p>
        <textarea
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
          placeholder="What specific action would help them decide with more confidence?"
          rows={2}
          className={`${textareaClass} mt-2`}
        />
      </div>

      {errors.general && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
          {errors.general}
        </p>
      )}

      <div className="pt-2">
        <Button type="submit" loading={loading} size="lg" className="w-full">
          Submit advice
        </Button>
        <p className="text-xs text-gray-400 text-center mt-3">
          Your response will be shared with the person who invited you only.
        </p>
      </div>
    </form>
  )
}
