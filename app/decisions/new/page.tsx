'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from '@/components/Button'
import type { DecisionType, AdviserInput } from '@/lib/types'
import { DECISION_TYPE_LABELS } from '@/lib/types'

const EMPTY_ADVISER: AdviserInput = { name: '', email: '', role_label: '' }

export default function NewDecisionPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [context, setContext] = useState('')
  const [decisionType, setDecisionType] = useState<DecisionType | ''>('')
  const [deadline, setDeadline] = useState('')
  const [advisers, setAdvisers] = useState<AdviserInput[]>([{ ...EMPTY_ADVISER }])

  const addAdviser = () => {
    if (advisers.length < 5) {
      setAdvisers([...advisers, { ...EMPTY_ADVISER }])
    }
  }

  const removeAdviser = (index: number) => {
    setAdvisers(advisers.filter((_, i) => i !== index))
  }

  const updateAdviser = (index: number, field: keyof AdviserInput, value: string) => {
    const updated = [...advisers]
    updated[index] = { ...updated[index], [field]: value }
    setAdvisers(updated)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const newErrors: Record<string, string> = {}
    if (!title.trim() || title.trim().length < 5) newErrors.title = 'Title must be at least 5 characters'
    if (!question.trim() || question.trim().length < 10) newErrors.question = 'Question must be at least 10 characters'
    if (!decisionType) newErrors.decision_type = 'Please select a decision type'

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    setLoading(true)

    try {
      const res = await fetch('/api/decisions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          question: question.trim(),
          context: context.trim() || undefined,
          decision_type: decisionType,
          deadline: deadline || undefined,
          advisers: advisers
            .filter((a) => a.name?.trim() || a.email?.trim())
            .map((a) => ({
              name: a.name?.trim() || undefined,
              email: a.email?.trim() || undefined,
              role_label: a.role_label?.trim() || undefined,
            })),
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        if (data.errors) {
          setErrors(data.errors)
        } else {
          setErrors({ general: data.error || 'Something went wrong' })
        }
        return
      }

      router.push(`/decisions/${data.decision_id}`)
    } catch {
      setErrors({ general: 'Something went wrong. Please try again.' })
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'w-full px-4 py-3 border border-gray-300 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-blue focus:border-transparent transition-shadow text-sm'
  const errorClass = 'mt-1 text-xs text-red-600'
  const labelClass = 'block text-sm font-medium text-gray-700 mb-1.5'

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">New decision</h1>
        <p className="text-gray-500 text-sm">
          Start with the decision itself. The sharper the question, the better the advice.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Decision details */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <h2 className="font-semibold text-gray-900">The decision</h2>

          <div>
            <label htmlFor="title" className={labelClass}>Decision title</label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Should I accept the new role?"
              className={inputClass}
            />
            {errors.title && <p className={errorClass}>{errors.title}</p>}
          </div>

          <div>
            <label htmlFor="question" className={labelClass}>The core question</label>
            <textarea
              id="question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Write the specific question you want your advisers to answer."
              rows={3}
              className={inputClass}
            />
            <p className="text-xs text-gray-400 mt-1">
              A good question is specific, decision-oriented and answerable.
            </p>
            {errors.question && <p className={errorClass}>{errors.question}</p>}
          </div>

          <div>
            <label htmlFor="context" className={labelClass}>
              Background and context{' '}
              <span className="font-normal text-gray-400">(recommended)</span>
            </label>
            <textarea
              id="context"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Give enough background for your advisers to give useful advice."
              rows={5}
              className={inputClass}
            />
            <p className="text-xs text-gray-400 mt-1">
              Include what is at stake, what options you are considering, and any constraints.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="decision_type" className={labelClass}>Decision type</label>
              <select
                id="decision_type"
                value={decisionType}
                onChange={(e) => setDecisionType(e.target.value as DecisionType)}
                className={inputClass}
              >
                <option value="">Select type</option>
                {(Object.entries(DECISION_TYPE_LABELS) as [DecisionType, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  )
                )}
              </select>
              {errors.decision_type && <p className={errorClass}>{errors.decision_type}</p>}
            </div>

            <div>
              <label htmlFor="deadline" className={labelClass}>
                Deadline{' '}
                <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input
                id="deadline"
                type="date"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
                min={new Date().toISOString().split('T')[0]}
                className={inputClass}
              />
            </div>
          </div>
        </div>

        {/* Advisers */}
        <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-5">
          <div>
            <h2 className="font-semibold text-gray-900 mb-1">Your advisers</h2>
            <p className="text-sm text-gray-500">
              Choose up to five people whose judgement you trust. The best advisers will tell you what you need to hear, not what you want to hear.
            </p>
          </div>

          <div className="space-y-4">
            {advisers.map((adviser, index) => (
              <div
                key={index}
                className="border border-gray-100 rounded-xl p-4 bg-gray-50 space-y-3"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700">
                    Adviser {index + 1}
                  </span>
                  {advisers.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeAdviser(index)}
                      className="text-xs text-gray-400 hover:text-red-500 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={adviser.name}
                    onChange={(e) => updateAdviser(index, 'name', e.target.value)}
                    placeholder="Name (optional)"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-blue bg-white"
                  />
                  <input
                    type="email"
                    value={adviser.email}
                    onChange={(e) => updateAdviser(index, 'email', e.target.value)}
                    placeholder="Email (optional)"
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-blue bg-white"
                  />
                </div>
                <input
                  type="text"
                  value={adviser.role_label}
                  onChange={(e) => updateAdviser(index, 'role_label', e.target.value)}
                  placeholder="Why you trust this person (optional) — e.g. Career mentor, former colleague"
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-blue bg-white"
                />
              </div>
            ))}
          </div>

          {advisers.length < 5 && (
            <button
              type="button"
              onClick={addAdviser}
              className="flex items-center gap-2 text-sm text-brand-blue hover:text-brand-blue-light font-medium transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add adviser ({advisers.length}/5)
            </button>
          )}
        </div>

        {errors.general && (
          <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-lg px-4 py-3">
            {errors.general}
          </p>
        )}

        <div className="flex items-center gap-4 justify-end">
          <button
            type="button"
            onClick={() => router.back()}
            className="text-sm text-gray-500 hover:text-gray-900 transition-colors"
          >
            Cancel
          </button>
          <Button type="submit" loading={loading} size="lg">
            Save decision and generate links
          </Button>
        </div>
      </form>
    </div>
  )
}
