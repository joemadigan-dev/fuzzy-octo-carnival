// V2 company universe and the XBRL concepts each metric may be tagged as.
//
// Two roles, deliberately not mixed (brief §2):
//   deployer — buys the infrastructure. Capex intensity and incremental
//              return on that capex are the question.
//   supplier — sells it. Its revenue is partly the mirror image of the
//              deployers' spending, so its economics must never be
//              averaged into theirs.
//
// CONCEPT CHAINS. Companies tag the same economics differently, and a
// wrong tag is worse than a missing one because it produces a plausible
// number. Every chain below was verified against live SEC data on
// 2026-09-19; what each company actually uses is noted.

export type Role = 'deployer' | 'supplier';

export interface Company {
  ticker: string;
  name: string;
  cik: string;          // zero-padded to 10, as the API expects
  role: Role;
  /** Fiscal year end MM-DD. Their quarters are NOT calendar quarters. */
  fiscalYearEnd: string;
  note?: string;
}

export const COMPANIES: Company[] = [
  { ticker: 'MSFT',  name: 'Microsoft', cik: '0000789019', role: 'deployer', fiscalYearEnd: '06-30' },
  { ticker: 'GOOGL', name: 'Alphabet',  cik: '0001652044', role: 'deployer', fiscalYearEnd: '12-31' },
  { ticker: 'AMZN',  name: 'Amazon',    cik: '0001018724', role: 'deployer', fiscalYearEnd: '12-31' },
  { ticker: 'META',  name: 'Meta',      cik: '0001326801', role: 'deployer', fiscalYearEnd: '12-31' },
  { ticker: 'ORCL',  name: 'Oracle',    cik: '0001341439', role: 'deployer', fiscalYearEnd: '05-31',
    note: 'Financed very differently from the cash-rich hyperscalers: long-term notes and loans rather than '
        + 'surplus operating cash. Its leverage is not comparable to theirs and the panel says so.' },
  { ticker: 'NVDA',  name: 'Nvidia',    cik: '0001045810', role: 'supplier', fiscalYearEnd: '01-31',
    note: 'The supplier, not a deployer. Its revenue is partly the mirror image of hyperscaler capex, so it is '
        + 'scored separately and never averaged into the deployer aggregate.' },
];

export const byTicker = new Map(COMPANIES.map((c) => [c.ticker, c]));

/** A metric is a FLOW (has start and end — revenue, capex) or a STOCK
 *  (an instant — debt, PP&E). They normalise completely differently. */
export type Kind = 'flow' | 'stock';

export interface ConceptDef {
  id: string;
  label: string;
  kind: Kind;
  /** Tried in order; the first chain whose parts all resolve wins. A chain
   *  of several tags is SUMMED. */
  chains: string[][];
  /** Stated on the page when the metric cannot be extracted for a company. */
  whenMissing?: string;
}

export const CONCEPTS: ConceptDef[] = [
  { id: 'revenue', label: 'Revenue', kind: 'flow', chains: [
      ['RevenueFromContractWithCustomerExcludingAssessedTax'],
      ['Revenues'],
    ] },
  { id: 'operating_income', label: 'Operating income', kind: 'flow', chains: [
      ['OperatingIncomeLoss'],
    ] },
  { id: 'ocf', label: 'Operating cash flow', kind: 'flow', chains: [
      ['NetCashProvidedByUsedInOperatingActivities'],
      ['NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    ] },
  { id: 'capex', label: 'Capital expenditure', kind: 'flow', chains: [
      ['PaymentsToAcquirePropertyPlantAndEquipment'],
      ['PaymentsToAcquireProductiveAssets'],
    ],
    whenMissing: 'Capital expenditure is not separately tagged in this filing.' },
  { id: 'da', label: 'Depreciation & amortisation', kind: 'flow', chains: [
      // AMZN, META, NVDA use the combined tag. MSFT, GOOGL and ORCL report
      // depreciation and intangible amortisation separately, so those are
      // summed rather than taking depreciation alone and understating it.
      ['DepreciationDepletionAndAmortization'],
      ['Depreciation', 'AmortizationOfIntangibleAssets'],
      ['Depreciation'],
    ] },
  { id: 'sbc', label: 'Stock-based compensation', kind: 'flow', chains: [
      ['ShareBasedCompensation'],
    ] },
  { id: 'interest_expense', label: 'Interest expense', kind: 'flow', chains: [
      ['InterestExpense'],
      ['InterestExpenseDebt'],
      ['InterestExpenseNonoperating'],
    ],
    whenMissing: 'Interest expense is not separately tagged; several of these companies report it net of interest income.' },

  { id: 'cash', label: 'Cash & equivalents', kind: 'stock', chains: [
      ['CashAndCashEquivalentsAtCarryingValue'],
    ] },
  { id: 'debt', label: 'Total debt', kind: 'stock', chains: [
      // Verified per company. The obvious-looking "…Debt Securities…" tags
      // are bond INVESTMENTS, not borrowings — matching on the word "debt"
      // would report the most levered company as the least.
      ['LongTermDebtNoncurrent', 'LongTermDebtCurrent'],   // MSFT, GOOGL, AMZN, NVDA
      ['LongTermNotesAndLoans', 'DebtCurrent'],            // ORCL
      ['LongTermNotesAndLoans'],
      ['LongTermDebtNoncurrent'],                          // META: no current portion tagged
      ['DebtLongtermAndShorttermCombinedAmount'],
      ['LongTermDebt'],
    ],
    whenMissing: 'Total borrowings could not be extracted reliably from the tagged facts. Not estimated.' },
  { id: 'ppe', label: 'PP&E, net', kind: 'stock', chains: [
      ['PropertyPlantAndEquipmentNet'],
    ] },
  { id: 'ppe_gross', label: 'PP&E, gross', kind: 'stock', chains: [
      ['PropertyPlantAndEquipmentGross'],
    ] },
  { id: 'cip', label: 'Construction in progress', kind: 'stock', chains: [
      ['ConstructionInProgressGross'],
    ],
    // Only GOOGL and ORCL disclose it. §22: never estimated.
    whenMissing: 'NOT DISCLOSED — this company does not separately tag construction in progress.' },
];

export const conceptById = new Map(CONCEPTS.map((c) => [c.id, c]));

/** SEC requires a descriptive User-Agent with contact details. */
export const SEC_USER_AGENT =
  'JoeMadigan Financial Conditions Barometer (joemadigan11@gmail.com)';

/** Only these forms carry the statements we normalise. */
export const ACCEPTED_FORMS = ['10-Q', '10-K'];
