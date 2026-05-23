'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Button from './Button'

interface GenerateBriefButtonProps {
  decisionId: string
  hasBrief: boolean
  responseCount: number
}

export default function GenerateBriefButton({
  decisionId,
  hasBrief,
  responseCount,
}: GenerateBriefButtonProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGenerate = async () => {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/decisions/${decisionId}/generate-brief`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate: hasBrief }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to generate brief')
      }

      router.push(`/decisions/${decisionId}/brief`)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <div className="space-y-2">
      {responseCount < 2 && (
        <p className="text-sm text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-4 py-2.5">
          For best results, wait for at least two advisers to respond. You can generate now but the brief will be more useful with more responses.
        </p>
      )}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          onClick={handleGenerate}
          loading={loading}
          disabled={responseCount === 0}
          size="lg"
        >
          {loading
            ? 'Synthesising adviser responses...'
            : hasBrief
              ? 'Regenerate brief'
              : 'Generate decision brief'}
        </Button>
        {hasBrief && !loading && (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => router.push(`/decisions/${decisionId}/brief`)}
          >
            View decision brief
          </Button>
        )}
      </div>
      {error && (
        <p className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
