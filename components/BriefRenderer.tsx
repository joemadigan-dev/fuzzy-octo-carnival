'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface BriefRendererProps {
  markdown: string
}

export default function BriefRenderer({ markdown }: BriefRendererProps) {
  return (
    <div className="prose prose-gray max-w-none
      prose-headings:font-semibold prose-headings:text-gray-900
      prose-h1:text-2xl prose-h1:mb-6
      prose-h2:text-base prose-h2:uppercase prose-h2:tracking-wide prose-h2:text-gray-500 prose-h2:mt-8 prose-h2:mb-3
      prose-p:text-gray-700 prose-p:leading-relaxed
      prose-ul:space-y-1 prose-li:text-gray-700
      prose-strong:text-gray-900
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  )
}
