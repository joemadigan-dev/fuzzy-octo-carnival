import type { Metadata } from 'next'
import Card from '@/components/Card'

export const metadata: Metadata = { title: 'Privacy' }

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-3xl font-semibold text-gray-900 mb-2">Privacy</h1>
      <p className="text-gray-500 mb-10">Last updated: May 2026</p>

      <Card padding="lg" className="space-y-8">
        {[
          {
            title: 'Your decisions are private',
            body: 'Decisions you create are only visible to you. No other user, including advisers, can see your decision dashboard, your responses, or your decision briefs.',
          },
          {
            title: 'Adviser responses are private',
            body: 'Adviser responses are visible only to you, the decision owner. Advisers cannot see each other\'s responses. We do not share individual adviser responses with any third party.',
          },
          {
            title: 'Invitation links are secure',
            body: 'Each adviser receives a unique, long, cryptographically random invitation link. Links should only be shared with the intended adviser. Do not post invitation links publicly.',
          },
          {
            title: 'AI synthesis',
            body: 'The app uses an AI model to synthesise adviser responses into a decision brief. Your decision context and adviser responses are sent to the AI provider for this purpose. We do not use your content to train AI models unless you have explicitly consented.',
          },
          {
            title: 'Sensitive decisions',
            body: 'Do not enter highly sensitive personal, medical, legal or financial information unless you are comfortable with it being processed by our AI provider for synthesis purposes. The decision brief is not professional legal, financial or medical advice.',
          },
          {
            title: 'Data retention',
            body: 'Your account data, decisions and adviser responses are stored securely. You can request deletion of your data at any time by contacting us.',
          },
          {
            title: 'Contact',
            body: 'For privacy questions or data requests, please contact us directly.',
          },
        ].map((section) => (
          <div key={section.title}>
            <h2 className="font-semibold text-gray-900 mb-2">{section.title}</h2>
            <p className="text-gray-600 text-sm leading-relaxed">{section.body}</p>
          </div>
        ))}
      </Card>
    </div>
  )
}
