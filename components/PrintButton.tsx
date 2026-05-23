'use client'

export default function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="text-sm text-gray-500 hover:text-gray-900 transition-colors print:hidden"
    >
      Print brief
    </button>
  )
}
