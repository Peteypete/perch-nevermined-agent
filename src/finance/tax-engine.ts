// Federal Tax Engine — 2024 brackets, QBI, Material Participation

// ============================================================================
// Federal Tax Brackets (2024, Single filer)
// ============================================================================

interface TaxBracket {
  min: number
  max: number
  rate: number
}

const FEDERAL_BRACKETS_SINGLE: TaxBracket[] = [
  { min: 0, max: 11_600, rate: 0.10 },
  { min: 11_600, max: 47_150, rate: 0.12 },
  { min: 47_150, max: 100_525, rate: 0.22 },
  { min: 100_525, max: 191_950, rate: 0.24 },
  { min: 191_950, max: 243_725, rate: 0.32 },
  { min: 243_725, max: 609_350, rate: 0.35 },
  { min: 609_350, max: Infinity, rate: 0.37 },
]

const FEDERAL_BRACKETS_MARRIED: TaxBracket[] = [
  { min: 0, max: 23_200, rate: 0.10 },
  { min: 23_200, max: 94_300, rate: 0.12 },
  { min: 94_300, max: 201_050, rate: 0.22 },
  { min: 201_050, max: 383_900, rate: 0.24 },
  { min: 383_900, max: 487_450, rate: 0.32 },
  { min: 487_450, max: 731_200, rate: 0.35 },
  { min: 731_200, max: Infinity, rate: 0.37 },
]

const STANDARD_DEDUCTION = {
  single: 14_600,
  married_joint: 29_200,
  married_separate: 14_600,
  head_of_household: 21_900,
}

export type FilingStatus = 'single' | 'married_joint' | 'married_separate' | 'head_of_household'

function getBrackets(status: FilingStatus): TaxBracket[] {
  return status === 'married_joint' ? FEDERAL_BRACKETS_MARRIED : FEDERAL_BRACKETS_SINGLE
}

export function calculateFederalTax(taxableIncome: number, filingStatus: FilingStatus = 'single') {
  const brackets = getBrackets(filingStatus)
  let tax = 0
  let remaining = Math.max(0, taxableIncome)
  const bracketBreakdown: { rate: number; taxableAmount: number; tax: number }[] = []

  for (const bracket of brackets) {
    if (remaining <= 0) break
    const taxableInBracket = Math.min(remaining, bracket.max - bracket.min)
    const bracketTax = taxableInBracket * bracket.rate
    tax += bracketTax
    bracketBreakdown.push({ rate: bracket.rate, taxableAmount: taxableInBracket, tax: bracketTax })
    remaining -= taxableInBracket
  }

  return {
    taxableIncome,
    totalTax: Math.round(tax * 100) / 100,
    effectiveRate: taxableIncome > 0 ? Math.round((tax / taxableIncome) * 10000) / 100 : 0,
    marginalRate: bracketBreakdown.length > 0 ? bracketBreakdown[bracketBreakdown.length - 1]!.rate : 0.10,
    bracketBreakdown,
  }
}

// ============================================================================
// Self-Employment Tax (for Schedule C / S-Corp comparison)
// ============================================================================

export function calculateSETax(netSelfEmploymentIncome: number) {
  const seTaxableIncome = netSelfEmploymentIncome * 0.9235
  const socialSecurityBase = Math.min(seTaxableIncome, 168_600) // 2024 cap
  const socialSecurityTax = socialSecurityBase * 0.124
  const medicareTax = seTaxableIncome * 0.029
  const additionalMedicare = Math.max(0, seTaxableIncome - 200_000) * 0.009
  const totalSETax = socialSecurityTax + medicareTax + additionalMedicare

  return {
    netIncome: netSelfEmploymentIncome,
    seTaxableIncome: Math.round(seTaxableIncome),
    socialSecurityTax: Math.round(socialSecurityTax),
    medicareTax: Math.round(medicareTax),
    additionalMedicare: Math.round(additionalMedicare),
    totalSETax: Math.round(totalSETax),
    deductibleHalf: Math.round(totalSETax / 2),
  }
}

// ============================================================================
// QBI (Qualified Business Income) Deduction — Section 199A
// ============================================================================

const QBI_PHASE_OUT = {
  single: { start: 191_950, end: 241_950 },
  married_joint: { start: 383_900, end: 483_900 },
  married_separate: { start: 191_950, end: 241_950 },
  head_of_household: { start: 191_950, end: 241_950 },
}

export function calculateQBIDeduction(qualifiedBusinessIncome: number, agi: number, filingStatus: FilingStatus = 'single') {
  const limits = QBI_PHASE_OUT[filingStatus]
  const maxDeduction = qualifiedBusinessIncome * 0.20

  if (agi <= limits.start) {
    // Full deduction
    return {
      qbi: qualifiedBusinessIncome,
      agi,
      maxDeduction: Math.round(maxDeduction),
      phaseOutPercent: 0,
      actualDeduction: Math.round(maxDeduction),
      status: 'full' as const,
      taxSavings: Math.round(maxDeduction * 0.24), // estimate at 24% marginal
      warning: null,
    }
  }

  if (agi >= limits.end) {
    // No deduction (for specified service trades — STR may still qualify)
    return {
      qbi: qualifiedBusinessIncome,
      agi,
      maxDeduction: Math.round(maxDeduction),
      phaseOutPercent: 100,
      actualDeduction: 0,
      status: 'phased_out' as const,
      taxSavings: 0,
      warning: 'AGI exceeds QBI phase-out threshold. Consider income deferral strategies.',
    }
  }

  // Partial phase-out
  const phaseOutRange = limits.end - limits.start
  const excessAGI = agi - limits.start
  const phaseOutPercent = Math.round((excessAGI / phaseOutRange) * 100)
  const reductionFactor = excessAGI / phaseOutRange
  const actualDeduction = maxDeduction * (1 - reductionFactor)

  return {
    qbi: qualifiedBusinessIncome,
    agi,
    maxDeduction: Math.round(maxDeduction),
    phaseOutPercent,
    actualDeduction: Math.round(actualDeduction),
    status: 'partial' as const,
    taxSavings: Math.round(actualDeduction * 0.24),
    warning: `AGI is $${(limits.end - agi).toLocaleString()} from full phase-out. Consider timing strategies.`,
  }
}

// ============================================================================
// Material Participation — 750-hour test
// ============================================================================

export function calculateMaterialParticipation(hours: number, propertyName?: string) {
  const threshold = 750
  const meetsThreshold = hours >= threshold
  const hoursRemaining = Math.max(0, threshold - hours)
  const percentComplete = Math.min(100, Math.round((hours / threshold) * 100))

  return {
    property: propertyName || 'Unknown',
    currentHours: hours,
    threshold,
    meetsThreshold,
    hoursRemaining,
    percentComplete,
    status: meetsThreshold ? 'qualified' : hours >= 700 ? 'near_threshold' : 'not_qualified',
    recommendation: meetsThreshold
      ? 'Material participation met. Losses are fully deductible against ordinary income.'
      : hoursRemaining <= 50
        ? `Only ${hoursRemaining} hours needed. Schedule on-site activities to reach threshold.`
        : `${hoursRemaining} hours needed. Consider increasing direct management involvement.`,
  }
}

// ============================================================================
// Combined Tax Projection
// ============================================================================

export function projectTaxLiability(params: {
  w2Income: number
  strNetIncome: number
  filingStatus: FilingStatus
  qualifiedBusinessIncome?: number
}) {
  const { w2Income, strNetIncome, filingStatus } = params
  const qbi = params.qualifiedBusinessIncome ?? strNetIncome
  const totalIncome = w2Income + strNetIncome
  const standardDeduction = STANDARD_DEDUCTION[filingStatus]
  const taxableIncome = Math.max(0, totalIncome - standardDeduction)

  const federalTax = calculateFederalTax(taxableIncome, filingStatus)
  const qbiDeduction = calculateQBIDeduction(qbi, totalIncome, filingStatus)

  // Tax with QBI deduction
  const taxableWithQBI = Math.max(0, taxableIncome - qbiDeduction.actualDeduction)
  const federalTaxWithQBI = calculateFederalTax(taxableWithQBI, filingStatus)

  return {
    income: {
      w2: w2Income,
      strNet: strNetIncome,
      totalGross: totalIncome,
      standardDeduction,
      taxableIncome,
    },
    federalTax: {
      beforeQBI: federalTax,
      afterQBI: federalTaxWithQBI,
      qbiSavings: Math.round(federalTax.totalTax - federalTaxWithQBI.totalTax),
    },
    qbi: qbiDeduction,
    summary: {
      estimatedTax: federalTaxWithQBI.totalTax,
      effectiveRate: federalTaxWithQBI.effectiveRate,
      marginalRate: federalTax.marginalRate,
      totalDeductions: standardDeduction + qbiDeduction.actualDeduction,
    },
  }
}
