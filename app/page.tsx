import Link from 'next/link'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Board of Five — Better decisions from the people you already trust',
}

const HOW_IT_WORKS = [
  {
    step: '01',
    title: 'Ask one important question',
    description:
      'Define what you are deciding and give your advisers the context they need. A sharp question leads to useful advice.',
  },
  {
    step: '02',
    title: 'Invite five trusted people',
    description:
      'Generate secure, private invitation links. Share them by email, WhatsApp or Slack. Advisers respond without creating an account.',
  },
  {
    step: '03',
    title: 'Receive structured advice',
    description:
      'Each adviser gives their recommendation, confidence level, the risks you might be underestimating, and what would change their mind.',
  },
  {
    step: '04',
    title: 'Get a clear decision brief',
    description:
      'Once responses are in, generate an AI-powered decision brief that synthesises the human advice, identifies patterns and recommends a next step.',
  },
]

const USE_CASES = [
  { title: 'Career decisions', example: 'Should I accept this role?' },
  { title: 'Business decisions', example: 'Should we launch this product now?' },
  { title: 'Hiring decisions', example: 'Should I hire this candidate?' },
  { title: 'Investment decisions', example: 'Should I invest in this opportunity?' },
  { title: 'Product decisions', example: 'Should we proceed with this partnership?' },
  { title: 'Personal decisions', example: 'Should I publish this article?' },
]

export default function LandingPage() {
  return (
    <div className="bg-cream">
      {/* Hero */}
      <section className="max-w-5xl mx-auto px-6 pt-24 pb-20 text-center">
        <p className="text-sm font-medium text-brand-blue uppercase tracking-widest mb-6">
          Board of Five
        </p>
        <h1 className="text-5xl sm:text-6xl font-semibold text-gray-900 leading-tight tracking-tight mb-6">
          Make better decisions<br className="hidden sm:block" /> with the people you already trust.
        </h1>
        <p className="text-xl text-gray-500 max-w-2xl mx-auto mb-10 leading-relaxed">
          Board of Five helps you ask five trusted advisers one important question, then turns their answers into a clear decision brief.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Link
            href="/signin"
            className="bg-brand-blue text-white text-base font-medium px-8 py-4 rounded-xl hover:bg-brand-blue-light transition-colors"
          >
            Create your Board of Five
          </Link>
          <a
            href="#how-it-works"
            className="text-base font-medium text-gray-600 hover:text-gray-900 transition-colors px-8 py-4"
          >
            See how it works →
          </a>
        </div>
        <p className="text-sm text-gray-400 mt-6">No credit card required. Free to start.</p>
      </section>

      {/* Example decision questions */}
      <section className="border-t border-gray-200 bg-white py-12">
        <div className="max-w-4xl mx-auto px-6">
          <p className="text-xs font-medium text-gray-400 uppercase tracking-widest text-center mb-6">
            Used for decisions like these
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            {[
              'Should I accept this role?',
              'Should we launch this product now or wait?',
              'Should I hire this candidate?',
              'Should I invest in this opportunity?',
              'Should we proceed with this partnership?',
              'Should I publish this article?',
            ].map((q) => (
              <span
                key={q}
                className="px-4 py-2 bg-gray-50 border border-gray-200 rounded-full text-sm text-gray-600"
              >
                {q}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="max-w-5xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-semibold text-gray-900 mb-4">How it works</h2>
          <p className="text-gray-500 max-w-xl mx-auto">
            From question to clarity in four steps. Most users complete the process in under two minutes.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
          {HOW_IT_WORKS.map((item) => (
            <div key={item.step} className="bg-white border border-gray-200 rounded-xl p-8">
              <div className="text-4xl font-light text-gray-200 mb-4">{item.step}</div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">{item.title}</h3>
              <p className="text-gray-500 leading-relaxed">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Example brief preview */}
      <section className="bg-white border-y border-gray-200 py-24">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-semibold text-gray-900 mb-4">
              What a decision brief looks like
            </h2>
            <p className="text-gray-500">
              Structured, clear and actionable. Not a list of opinions — a synthesis.
            </p>
          </div>
          <div className="bg-cream border border-gray-200 rounded-2xl p-8 space-y-6">
            <div>
              <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-1">
                Decision
              </p>
              <h3 className="text-xl font-semibold text-gray-900">Should I accept the new role?</h3>
              <p className="text-sm text-gray-500 mt-1">4 of 5 advisers responded · Career decision</p>
            </div>

            <div className="grid grid-cols-5 gap-2 pt-2">
              {[
                { label: 'Strong yes', color: 'bg-green-100 text-green-800', count: 1 },
                { label: 'Lean yes', color: 'bg-emerald-50 text-emerald-700', count: 2 },
                { label: 'Uncertain', color: 'bg-yellow-50 text-yellow-700', count: 1 },
                { label: 'Lean no', color: 'bg-orange-50 text-orange-700', count: 0 },
                { label: 'Strong no', color: 'bg-red-50 text-red-700', count: 0 },
              ].map((item) => (
                <div
                  key={item.label}
                  className={`rounded-lg p-3 text-center ${item.color} ${item.count === 0 ? 'opacity-30' : ''}`}
                >
                  <div className="text-2xl font-semibold">{item.count}</div>
                  <div className="text-xs mt-0.5">{item.label}</div>
                </div>
              ))}
            </div>

            <div className="space-y-4 pt-2">
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-2">
                  Executive summary
                </p>
                <p className="text-gray-700 leading-relaxed text-sm">
                  Three of four advisers lean towards proceeding, but the support is conditional rather than unconditional. The strongest argument for proceeding is the scale of the opportunity. The strongest argument for caution is the lack of clarity around authority, ownership and downside protection.
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400 uppercase tracking-widest mb-2">
                  Suggested decision
                </p>
                <span className="inline-flex items-center px-3 py-1 bg-brand-blue text-white rounded-full text-sm font-medium">
                  Proceed with conditions
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why it works */}
      <section className="max-w-5xl mx-auto px-6 py-24">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-semibold text-gray-900 mb-4">Why it works</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          {[
            {
              title: 'Human judgement, AI synthesis',
              description:
                'The advice comes from people who know you. The AI synthesises it into a structured brief — it does not replace the human element.',
            },
            {
              title: 'Structured, not opinionated',
              description:
                'Advisers answer specific questions about risk, confidence and what would change their mind. You get analysis, not noise.',
            },
            {
              title: 'Private by design',
              description:
                'Advisers access a secure link and cannot see each other\'s responses. Your decision brief is visible only to you.',
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="font-semibold text-gray-900 mb-2">{item.title}</h3>
              <p className="text-gray-500 leading-relaxed text-sm">{item.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Use cases */}
      <section className="bg-white border-t border-gray-200 py-24">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-semibold text-gray-900 mb-4">Built for any important decision</h2>
            <p className="text-gray-500">
              Executives, founders, investors, professionals — anyone facing a decision that matters.
            </p>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {USE_CASES.map((item) => (
              <div
                key={item.title}
                className="bg-cream border border-gray-200 rounded-xl p-6"
              >
                <h3 className="font-semibold text-gray-900 mb-1 text-sm">{item.title}</h3>
                <p className="text-xs text-gray-500 italic">&ldquo;{item.example}&rdquo;</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className="max-w-3xl mx-auto px-6 py-24 text-center">
        <div className="bg-white border border-gray-200 rounded-2xl p-10">
          <div className="w-12 h-12 bg-brand-blue-50 rounded-xl flex items-center justify-center mx-auto mb-4">
            <svg className="h-6 w-6 text-brand-blue" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 mb-3">Private by default</h2>
          <p className="text-gray-500 leading-relaxed max-w-lg mx-auto">
            Your decisions are private. Advisers can only respond through secure invitation links. No adviser can see another adviser&apos;s response. Your decision brief is visible only to you.
          </p>
        </div>
      </section>

      {/* Final CTA */}
      <section className="bg-brand-blue py-24">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-4xl font-semibold text-white mb-4 leading-tight">
            What decision are you working through?
          </h2>
          <p className="text-blue-200 mb-10 text-lg">
            Create a private advisory board for any important decision.
          </p>
          <Link
            href="/signin"
            className="bg-white text-brand-blue text-base font-semibold px-8 py-4 rounded-xl hover:bg-gray-50 transition-colors inline-block"
          >
            Create your Board of Five
          </Link>
        </div>
      </section>
    </div>
  )
}
