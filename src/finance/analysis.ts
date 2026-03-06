// High-level analysis functions — Property, Portfolio, Entity Recommendation

import type { Owner, Entity, Property, LedgerEntry, PriorYearReturn } from '../types.js'
import { CHART_OF_ACCOUNTS } from '../types.js'
import { calculateNOI, getEntityPnL } from './trial-balance.js'
import {
  projectTaxLiability,
  calculateQBIDeduction,
  calculateMaterialParticipation,
  calculateSETax,
  type FilingStatus,
} from './tax-engine.js'
import {
  getOwner,
  getEntity,
  getProperty,
  getPropertiesByEntity,
  getLedgerByEntity,
  getLedgerByProperty,
  getAllEntitiesByOwner,
} from '../data/store.js'

// ============================================================================
// Property NOI Analysis
// ============================================================================

export async function analyzePropertyNOI(propertyId: string) {
  const property = await getProperty(propertyId)
  if (!property) throw new Error(`Property ${propertyId} not found`)

  const entries = await getLedgerByProperty(propertyId)
  const noi = calculateNOI(entries, property)

  // Material participation check
  const mp = calculateMaterialParticipation(property.materialParticipationHours, property.name)

  // Annualized projections based on occupancy
  const daysInYear = 365
  const occupiedNights = Math.round(daysInYear * property.avgOccupancy)
  const projectedAnnualRevenue = occupiedNights * property.nightlyRate + occupiedNights * property.cleaningFee
  const projectedAnnualExpenses = property.monthlyExpenses * 12
  const projectedAnnualNOI = projectedAnnualRevenue - projectedAnnualExpenses

  return {
    property: {
      id: property.id,
      name: property.name,
      address: `${property.address}, ${property.city}, ${property.state}`,
      nightlyRate: property.nightlyRate,
      cleaningFee: property.cleaningFee,
      avgOccupancy: `${Math.round(property.avgOccupancy * 100)}%`,
    },
    ytd: noi,
    annualProjection: {
      occupiedNights,
      projectedRevenue: Math.round(projectedAnnualRevenue),
      projectedExpenses: Math.round(projectedAnnualExpenses),
      projectedNOI: Math.round(projectedAnnualNOI),
      noiMargin: projectedAnnualRevenue > 0
        ? Math.round((projectedAnnualNOI / projectedAnnualRevenue) * 10000) / 100
        : 0,
    },
    materialParticipation: mp,
    capRate: property.purchasePrice > 0
      ? Math.round((projectedAnnualNOI / property.purchasePrice) * 10000) / 100
      : null,
  }
}

// ============================================================================
// Tax Projection
// ============================================================================

export async function analyzeTaxProjection(ownerId: string, priorYearReturn?: PriorYearReturn) {
  const owner = await getOwner(ownerId)
  if (!owner) throw new Error(`Owner ${ownerId} not found`)

  const entities = await getAllEntitiesByOwner(ownerId)
  let totalSTRNet = 0

  const entityDetails = []
  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id, entity.name)
    totalSTRNet += pnl.netIncome
    entityDetails.push(pnl)
  }

  const projection = projectTaxLiability({
    w2Income: owner.w2Income,
    strNetIncome: totalSTRNet,
    filingStatus: owner.filingStatus,
    qualifiedBusinessIncome: totalSTRNet,
  })

  const result: Record<string, unknown> = {
    owner: { name: owner.name, filingStatus: owner.filingStatus, w2Income: owner.w2Income },
    entities: entityDetails,
    taxProjection: projection,
  }

  // If prior year return provided, add YoY comparison
  if (priorYearReturn) {
    result.priorYear = buildPriorYearSummary(priorYearReturn)
    result.yearOverYear = buildYearOverYearComparison(
      projection, priorYearReturn, owner.w2Income, totalSTRNet
    )
  }

  return result
}

// --- Prior Year helpers ---

function buildPriorYearSummary(py: PriorYearReturn) {
  return {
    taxYear: py.taxYear,
    filingStatus: py.filingStatus,
    w2Income: py.w2Income,
    businessIncome: py.businessIncome,
    totalIncome: py.totalIncome,
    agi: py.adjustedGrossIncome,
    deductions: py.deductionAmount,
    taxableIncome: py.taxableIncome,
    totalTax: py.totalTax,
    totalPayments: py.totalPayments,
    refundOrOwed: py.refundOrOwed,
    qbiDeduction: py.qbiDeduction ?? 0,
    scheduleEIncome: py.scheduleEIncome ?? 0,
    depreciationClaimed: py.depreciationClaimed ?? 0,
    effectiveRate: py.effectiveRate ?? (py.adjustedGrossIncome > 0
      ? Math.round((py.totalTax / py.adjustedGrossIncome) * 10000) / 100
      : 0),
  }
}

function buildYearOverYearComparison(
  cyProjection: ReturnType<typeof projectTaxLiability>,
  py: PriorYearReturn,
  cyW2: number,
  cySTRNet: number,
) {
  const cyTotalIncome = cyW2 + cySTRNet
  const cyTax = cyProjection.summary.estimatedTax
  const cyEffRate = cyProjection.summary.effectiveRate
  const pyEffRate = py.effectiveRate ?? (py.adjustedGrossIncome > 0
    ? Math.round((py.totalTax / py.adjustedGrossIncome) * 10000) / 100
    : 0)

  const pctChange = (curr: number, prev: number) =>
    prev !== 0 ? Math.round(((curr - prev) / Math.abs(prev)) * 10000) / 100 : null

  const deltas = {
    w2Income: { py: py.w2Income, cy: cyW2, change: cyW2 - py.w2Income, pctChange: pctChange(cyW2, py.w2Income) },
    businessIncome: { py: py.businessIncome, cy: cySTRNet, change: cySTRNet - py.businessIncome, pctChange: pctChange(cySTRNet, py.businessIncome) },
    totalIncome: { py: py.totalIncome, cy: cyTotalIncome, change: cyTotalIncome - py.totalIncome, pctChange: pctChange(cyTotalIncome, py.totalIncome) },
    totalTax: { py: py.totalTax, cy: cyTax, change: Math.round(cyTax - py.totalTax), pctChange: pctChange(cyTax, py.totalTax) },
    effectiveRate: { py: pyEffRate, cy: cyEffRate, change: Math.round((cyEffRate - pyEffRate) * 100) / 100 },
    qbiDeduction: { py: py.qbiDeduction ?? 0, cy: cyProjection.qbi.actualDeduction, change: cyProjection.qbi.actualDeduction - (py.qbiDeduction ?? 0) },
  }

  const insights = generateYoYInsights(cyProjection, py, cyW2, cySTRNet, deltas)

  return { deltas, insights }
}

function generateYoYInsights(
  cyProjection: ReturnType<typeof projectTaxLiability>,
  py: PriorYearReturn,
  cyW2: number,
  cySTRNet: number,
  deltas: Record<string, any>,
): string[] {
  const insights: string[] = []

  // Tax change headline
  const taxChange = deltas.totalTax.change
  if (taxChange > 1000) {
    insights.push(`Tax liability is ~$${Math.abs(taxChange).toLocaleString()} higher than ${py.taxYear}. Review estimated payment schedule to avoid underpayment penalty.`)
  } else if (taxChange < -1000) {
    insights.push(`Tax liability is ~$${Math.abs(taxChange).toLocaleString()} lower than ${py.taxYear}. You may be over-withholding — consider adjusting W-4 or estimated payments.`)
  } else {
    insights.push(`Tax liability is roughly flat vs ${py.taxYear} (within $1,000).`)
  }

  // QBI changes
  const cyQBI = cyProjection.qbi.actualDeduction
  const pyQBI = py.qbiDeduction ?? 0
  if (cyQBI > 0 && pyQBI === 0) {
    insights.push(`New QBI deduction of $${cyQBI.toLocaleString()} available this year — saves ~$${cyProjection.federalTax.qbiSavings.toLocaleString()}.`)
  } else if (cyQBI === 0 && pyQBI > 0) {
    insights.push(`QBI deduction lost vs ${py.taxYear} ($${pyQBI.toLocaleString()} → $0). AGI may have exceeded phase-out threshold.`)
  } else if (cyQBI > 0 && pyQBI > 0 && Math.abs(cyQBI - pyQBI) > 500) {
    const dir = cyQBI > pyQBI ? 'increased' : 'decreased'
    insights.push(`QBI deduction ${dir} by $${Math.abs(cyQBI - pyQBI).toLocaleString()} (${py.taxYear}: $${pyQBI.toLocaleString()} → CY: $${cyQBI.toLocaleString()}).`)
  }

  // Income mix shift
  const pyBizPct = py.totalIncome > 0 ? (py.businessIncome / py.totalIncome) * 100 : 0
  const cyTotal = cyW2 + cySTRNet
  const cyBizPct = cyTotal > 0 ? (cySTRNet / cyTotal) * 100 : 0
  if (Math.abs(cyBizPct - pyBizPct) > 5) {
    insights.push(`Business income shifted from ${Math.round(pyBizPct)}% to ${Math.round(cyBizPct)}% of total income — review entity structure and SE tax exposure.`)
  }

  // Underpayment risk
  const pyPayments = py.totalPayments
  const cyEstTax = cyProjection.summary.estimatedTax
  if (cyEstTax > pyPayments * 1.1) {
    const safeHarbor = Math.round(py.totalTax * 1.1)
    insights.push(`Safe harbor: pay at least $${safeHarbor.toLocaleString()} (110% of ${py.taxYear} tax) in estimated payments to avoid underpayment penalty.`)
  }

  return insights
}

// ============================================================================
// QBI Analysis
// ============================================================================

export async function analyzeQBI(ownerId: string) {
  const owner = await getOwner(ownerId)
  if (!owner) throw new Error(`Owner ${ownerId} not found`)

  const entities = await getAllEntitiesByOwner(ownerId)
  let totalSTRNet = 0
  const entityBreakdown = []

  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id, entity.name)
    totalSTRNet += pnl.netIncome
    entityBreakdown.push({
      entity: entity.name,
      type: entity.type,
      netIncome: pnl.netIncome,
    })
  }

  const totalIncome = owner.w2Income + totalSTRNet
  const qbi = calculateQBIDeduction(totalSTRNet, totalIncome, owner.filingStatus)

  // Material participation across all properties
  const mpStatus = []
  for (const entity of entities) {
    const properties = await getPropertiesByEntity(entity.id)
    for (const prop of properties) {
      mpStatus.push(calculateMaterialParticipation(prop.materialParticipationHours, prop.name))
    }
  }

  return {
    owner: { name: owner.name, w2Income: owner.w2Income },
    totalSTRIncome: totalSTRNet,
    totalAGI: totalIncome,
    qbiAnalysis: qbi,
    entityBreakdown,
    materialParticipation: mpStatus,
    strategies: generateQBIStrategies(qbi, totalIncome, owner.filingStatus),
  }
}

function generateQBIStrategies(qbi: ReturnType<typeof calculateQBIDeduction>, agi: number, filingStatus: FilingStatus) {
  const strategies: string[] = []

  if (qbi.status === 'partial') {
    const phaseOutStart = filingStatus === 'married_joint' ? 383_900 : 191_950
    const amountOver = agi - phaseOutStart
    strategies.push(`AGI is $${amountOver.toLocaleString()} over the QBI phase-out start. Consider deferring $${amountOver.toLocaleString()} in income to next year.`)
    strategies.push(`Contributing to a traditional IRA or 401(k) could reduce AGI below the $${phaseOutStart.toLocaleString()} threshold.`)
  }

  if (qbi.status === 'phased_out') {
    strategies.push('QBI is fully phased out. Consider entity restructuring or income splitting strategies.')
    strategies.push('Evaluate whether S-Corp election could provide W-2/distribution split to reduce overall tax burden.')
  }

  if (qbi.actualDeduction > 0) {
    strategies.push(`Current QBI deduction saves approximately $${qbi.taxSavings.toLocaleString()} in federal taxes.`)
  }

  return strategies
}

// ============================================================================
// Expense Classification
// ============================================================================

export function classifyExpense(description: string, amount: number) {
  const desc = description.toLowerCase()

  // Pattern matching for common STR expenses
  const patterns: [RegExp, string][] = [
    [/clean|housekeep|turnover|laundry/, '5100'],
    [/repair|maint|fix|plumb|hvac|electric/, '5200'],
    [/utilit|water|gas|electric|internet|wifi|trash/, '5300'],
    [/insur|liability|coverage|policy/, '5400'],
    [/manage|property manag|platform fee|airbnb fee|host fee/, '5500'],
    [/mortgage|interest|loan/, '6100'],
    [/property tax|real estate tax|county tax/, '6200'],
    [/deprec|amortiz/, '6800'],
    [/rent|booking|revenue|income|guest payment/, '4100'],
    [/cleaning fee.*collect|guest.*clean/, '4200'],
  ]

  for (const [pattern, code] of patterns) {
    if (pattern.test(desc)) {
      const account = CHART_OF_ACCOUNTS[code]!
      return {
        description,
        amount,
        accountCode: code,
        accountName: account.name,
        type: account.type,
        scheduleELine: account.scheduleELine,
        confidence: 'high',
      }
    }
  }

  // Default: general maintenance
  return {
    description,
    amount,
    accountCode: '5200',
    accountName: 'Repairs & Maintenance',
    type: 'expense' as const,
    scheduleELine: 'Line 14',
    confidence: 'low',
  }
}

// ============================================================================
// Portfolio Report
// ============================================================================

export async function generatePortfolioReport(ownerId: string) {
  const owner = await getOwner(ownerId)
  if (!owner) throw new Error(`Owner ${ownerId} not found`)

  const entities = await getAllEntitiesByOwner(ownerId)
  const entityReports = []
  let totalRevenue = 0
  let totalExpenses = 0
  const allProperties = []

  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id, entity.name)
    totalRevenue += pnl.revenue
    totalExpenses += pnl.expenses

    const properties = await getPropertiesByEntity(entity.id)
    for (const prop of properties) {
      const propEntries = entries.filter(e => e.propertyId === prop.id)
      const propNOI = calculateNOI(propEntries, prop)
      const mp = calculateMaterialParticipation(prop.materialParticipationHours, prop.name)
      allProperties.push({ ...propNOI, materialParticipation: mp })
    }

    entityReports.push(pnl)
  }

  const totalNet = totalRevenue - totalExpenses
  const taxProjection = projectTaxLiability({
    w2Income: owner.w2Income,
    strNetIncome: totalNet,
    filingStatus: owner.filingStatus,
  })

  return {
    owner: { name: owner.name, w2Income: owner.w2Income, filingStatus: owner.filingStatus },
    portfolio: {
      totalProperties: allProperties.length,
      totalEntities: entities.length,
      totalRevenue: Math.round(totalRevenue),
      totalExpenses: Math.round(totalExpenses),
      totalNetIncome: Math.round(totalNet),
      overallNOIMargin: totalRevenue > 0 ? Math.round((totalNet / totalRevenue) * 10000) / 100 : 0,
    },
    entities: entityReports,
    properties: allProperties,
    taxProjection,
    alerts: generateAlerts(allProperties, taxProjection),
  }
}

function generateAlerts(properties: any[], taxProjection: any): string[] {
  const alerts: string[] = []

  // Material participation alerts
  for (const prop of properties) {
    if (prop.materialParticipation?.status === 'near_threshold') {
      alerts.push(`${prop.propertyName}: Only ${prop.materialParticipation.hoursRemaining} hours from material participation threshold`)
    }
  }

  // QBI alerts
  if (taxProjection.qbi?.status === 'partial') {
    alerts.push(`QBI deduction is partially phased out. ${taxProjection.qbi.warning}`)
  }

  // NOI alerts
  for (const prop of properties) {
    if (prop.noiMargin < 20) {
      alerts.push(`${prop.propertyName}: NOI margin is ${prop.noiMargin}% — below healthy threshold of 20%`)
    }
  }

  return alerts
}

// ============================================================================
// Entity Structure Recommendation
// ============================================================================

// ============================================================================
// 1031 Like-Kind Exchange Analysis
// ============================================================================

export async function analyze1031Exchange(params: Record<string, unknown>) {
  const relinquishedValue = (params.relinquished_value as number) || 500_000
  const relinquishedBasis = (params.relinquished_basis as number) || 300_000
  const replacementValue = (params.replacement_value as number) || 650_000
  const mortgageRelieved = (params.mortgage_relieved as number) || 200_000
  const mortgageAssumed = (params.mortgage_assumed as number) || 280_000
  const closingDate = (params.closing_date as string) || new Date().toISOString().split('T')[0]

  const realizedGain = relinquishedValue - relinquishedBasis
  const bootReceived = Math.max(0, mortgageRelieved - mortgageAssumed)
  const cashBoot = (params.cash_received as number) || 0
  const totalBoot = bootReceived + cashBoot
  const recognizedGain = Math.min(totalBoot, realizedGain)
  const deferredGain = realizedGain - recognizedGain
  const newBasis = replacementValue - deferredGain

  // Timeline deadlines
  const close = new Date(closingDate)
  const identification = new Date(close.getTime() + 45 * 86400000)
  const completion = new Date(close.getTime() + 180 * 86400000)

  // Tax savings estimate (federal + state avg)
  const taxRate = 0.238 // 20% LTCG + 3.8% NIIT
  const taxDeferred = Math.round(deferredGain * taxRate)
  const depreciationRecapture = Math.round(Math.min(realizedGain, relinquishedValue - relinquishedBasis) * 0.25 * 0.6) // partial recapture

  return {
    relinquishedProperty: {
      value: relinquishedValue,
      adjustedBasis: relinquishedBasis,
      mortgageRelieved,
    },
    replacementProperty: {
      value: replacementValue,
      mortgageAssumed,
      newAdjustedBasis: newBasis,
    },
    exchange: {
      realizedGain,
      bootReceived: totalBoot,
      recognizedGain,
      deferredGain,
      taxDeferred,
      depreciationRecaptureExposure: depreciationRecapture,
    },
    timeline: {
      closingDate,
      identificationDeadline: identification.toISOString().split('T')[0],
      completionDeadline: completion.toISOString().split('T')[0],
      daysToIdentify: 45,
      daysToComplete: 180,
    },
    rules: {
      threePropertyRule: 'May identify up to 3 replacement properties regardless of value',
      twoHundredPercentRule: `Total value of identified properties must not exceed $${(relinquishedValue * 2).toLocaleString()}`,
      qualifiedIntermediary: 'Must use a Qualified Intermediary — cannot touch funds directly',
      relatedParties: 'Cannot exchange with related parties (2-year holding requirement)',
    },
    strategies: [
      deferredGain > 100_000 ? `Deferring $${deferredGain.toLocaleString()} saves ~$${taxDeferred.toLocaleString()} in federal taxes` : null,
      totalBoot > 0 ? `Boot of $${totalBoot.toLocaleString()} will be taxed as capital gain — consider increasing mortgage on replacement to offset` : null,
      'Consider "improvement exchange" if replacement property needs renovation',
      'Step-up in basis at death eliminates deferred gain for heirs (IRC §1014)',
    ].filter(Boolean),
  }
}

// ============================================================================
// State Relocation Tax Analysis
// ============================================================================

export async function analyzeStateRelocation(params: Record<string, unknown>) {
  const ownerId = (params.owner_id as string) || 'owner-01'
  const currentState = (params.current_state as string) || 'CA'
  const targetStates = (params.target_states as string[]) || ['TX', 'FL', 'NV', 'WA', 'TN']
  const annualIncome = (params.annual_income as number) || 250_000
  const strIncome = (params.str_income as number) || 80_000
  const capitalGains = (params.capital_gains as number) || 50_000

  // State tax rates (simplified top marginal rates for 2024)
  const stateRates: Record<string, { income: number; capitalGains: number; property: number; name: string }> = {
    CA: { income: 0.133, capitalGains: 0.133, property: 0.0073, name: 'California' },
    NY: { income: 0.109, capitalGains: 0.109, property: 0.0162, name: 'New York' },
    NJ: { income: 0.1075, capitalGains: 0.1075, property: 0.0249, name: 'New Jersey' },
    TX: { income: 0, capitalGains: 0, property: 0.018, name: 'Texas' },
    FL: { income: 0, capitalGains: 0, property: 0.0089, name: 'Florida' },
    NV: { income: 0, capitalGains: 0, property: 0.0055, name: 'Nevada' },
    WA: { income: 0, capitalGains: 0.07, property: 0.0093, name: 'Washington' },
    TN: { income: 0, capitalGains: 0, property: 0.0064, name: 'Tennessee' },
    WY: { income: 0, capitalGains: 0, property: 0.0057, name: 'Wyoming' },
    SD: { income: 0, capitalGains: 0, property: 0.0122, name: 'South Dakota' },
    AZ: { income: 0.025, capitalGains: 0.025, property: 0.0062, name: 'Arizona' },
    CO: { income: 0.044, capitalGains: 0.044, property: 0.005, name: 'Colorado' },
    HI: { income: 0.11, capitalGains: 0.0725, property: 0.0028, name: 'Hawaii' },
    OR: { income: 0.099, capitalGains: 0.099, property: 0.0093, name: 'Oregon' },
    MT: { income: 0.059, capitalGains: 0.059, property: 0.0083, name: 'Montana' },
    NC: { income: 0.0475, capitalGains: 0.0475, property: 0.0077, name: 'North Carolina' },
  }

  const totalIncome = annualIncome + strIncome
  const propertyValue = (params.property_value as number) || 500_000

  function calcStateTax(stateCode: string) {
    const rate = stateRates[stateCode] || { income: 0.05, capitalGains: 0.05, property: 0.01, name: stateCode }
    const incomeTax = Math.round(totalIncome * rate.income)
    const capGainsTax = Math.round(capitalGains * rate.capitalGains)
    const propertyTax = Math.round(propertyValue * rate.property)
    return {
      state: stateCode,
      stateName: rate.name,
      incomeTaxRate: `${(rate.income * 100).toFixed(1)}%`,
      capitalGainsTaxRate: `${(rate.capitalGains * 100).toFixed(1)}%`,
      propertyTaxRate: `${(rate.property * 100).toFixed(2)}%`,
      estimatedIncomeTax: incomeTax,
      estimatedCapGainsTax: capGainsTax,
      estimatedPropertyTax: propertyTax,
      totalAnnualTaxBurden: incomeTax + capGainsTax + propertyTax,
    }
  }

  const currentTax = calcStateTax(currentState)
  const comparisons = targetStates.map(s => {
    const target = calcStateTax(s)
    return {
      ...target,
      annualSavings: currentTax.totalAnnualTaxBurden - target.totalAnnualTaxBurden,
      fiveYearSavings: (currentTax.totalAnnualTaxBurden - target.totalAnnualTaxBurden) * 5,
    }
  }).sort((a, b) => b.annualSavings - a.annualSavings)

  return {
    currentState: currentTax,
    income: { w2: annualIncome, str: strIncome, capitalGains, total: totalIncome + capitalGains },
    comparisons,
    topRecommendation: comparisons[0],
    domicileChecklist: [
      'Register to vote in new state',
      'Obtain new state driver\'s license',
      'Update mailing address on all accounts',
      'File part-year returns for both states in transition year',
      'Spend 183+ days in new state',
      'Move primary banking to new state',
      'Update estate planning documents',
      'Cancel old state voter registration',
    ],
    warnings: [
      currentState === 'CA' ? 'California aggressively audits departures — maintain clean break documentation' : null,
      currentState === 'NY' ? 'New York requires 548-day analysis for statutory residency — keep detailed travel log' : null,
      'Some states tax income sourced from that state regardless of residency (e.g., rental property income)',
      'STR income may still be taxed in the state where the property is located',
    ].filter(Boolean),
  }
}

// ============================================================================
// International Real Estate Tax Analysis
// ============================================================================

export async function analyzeInternational(params: Record<string, unknown>) {
  const country = (params.country as string) || 'Mexico'
  const propertyValue = (params.property_value as number) || 400_000
  const annualRentalIncome = (params.annual_rental_income as number) || 60_000
  const annualExpenses = (params.annual_expenses as number) || 20_000
  const purchasePrice = (params.purchase_price as number) || 350_000
  const holdingYears = (params.holding_years as number) || 5
  const usPersonType = (params.us_person_type as string) || 'individual'

  // Country tax profiles
  const countryProfiles: Record<string, { withholdingRate: number; treatyRate: number; localIncomeTaxRate: number; vatRate: number; hasTreaty: boolean; firptaLike: boolean; name: string }> = {
    Mexico: { withholdingRate: 0.25, treatyRate: 0.10, localIncomeTaxRate: 0.35, vatRate: 0.16, hasTreaty: true, firptaLike: true, name: 'Mexico' },
    Canada: { withholdingRate: 0.25, treatyRate: 0.15, localIncomeTaxRate: 0.33, vatRate: 0.05, hasTreaty: true, firptaLike: true, name: 'Canada' },
    UK: { withholdingRate: 0.20, treatyRate: 0.15, localIncomeTaxRate: 0.45, vatRate: 0.20, hasTreaty: true, firptaLike: true, name: 'United Kingdom' },
    Portugal: { withholdingRate: 0.25, treatyRate: 0.10, localIncomeTaxRate: 0.48, vatRate: 0.23, hasTreaty: true, firptaLike: false, name: 'Portugal' },
    Spain: { withholdingRate: 0.24, treatyRate: 0.10, localIncomeTaxRate: 0.47, vatRate: 0.21, hasTreaty: true, firptaLike: false, name: 'Spain' },
    Thailand: { withholdingRate: 0.15, treatyRate: 0.15, localIncomeTaxRate: 0.35, vatRate: 0.07, hasTreaty: true, firptaLike: false, name: 'Thailand' },
    Japan: { withholdingRate: 0.2042, treatyRate: 0.10, localIncomeTaxRate: 0.45, vatRate: 0.10, hasTreaty: true, firptaLike: true, name: 'Japan' },
    Dubai: { withholdingRate: 0, treatyRate: 0, localIncomeTaxRate: 0.09, vatRate: 0.05, hasTreaty: false, firptaLike: false, name: 'UAE (Dubai)' },
    Colombia: { withholdingRate: 0.20, treatyRate: 0.10, localIncomeTaxRate: 0.35, vatRate: 0.19, hasTreaty: true, firptaLike: false, name: 'Colombia' },
    CostaRica: { withholdingRate: 0.15, treatyRate: 0.15, localIncomeTaxRate: 0.25, vatRate: 0.13, hasTreaty: false, firptaLike: false, name: 'Costa Rica' },
  }

  const profile = countryProfiles[country] || countryProfiles['Mexico']
  const netRentalIncome = annualRentalIncome - annualExpenses

  // Foreign tax paid
  const foreignIncomeTax = Math.round(netRentalIncome * profile.localIncomeTaxRate)
  const withholding = Math.round(annualRentalIncome * (profile.hasTreaty ? profile.treatyRate : profile.withholdingRate))

  // US tax obligations (worldwide income)
  const usRate = 0.24 // effective federal rate
  const usTaxBeforeCredit = Math.round(netRentalIncome * usRate)
  const foreignTaxCredit = Math.min(foreignIncomeTax, usTaxBeforeCredit)
  const netUsTax = Math.max(0, usTaxBeforeCredit - foreignTaxCredit)

  // FIRPTA analysis (if selling)
  const estimatedGain = propertyValue - purchasePrice
  const firptaWithholding = Math.round(propertyValue * 0.15) // 15% of gross
  const actualCapGainsTax = Math.round(estimatedGain * 0.238) // 20% LTCG + 3.8% NIIT

  // FBAR / FATCA thresholds
  const fbarRequired = propertyValue > 10_000
  const fatcaRequired = usPersonType === 'individual' ? propertyValue > 50_000 : propertyValue > 250_000

  return {
    country: profile.name,
    property: { value: propertyValue, purchasePrice, annualRentalIncome, annualExpenses, netIncome: netRentalIncome },
    foreignTax: {
      localIncomeTax: foreignIncomeTax,
      localTaxRate: `${(profile.localIncomeTaxRate * 100).toFixed(1)}%`,
      withholding,
      withholdingRate: `${((profile.hasTreaty ? profile.treatyRate : profile.withholdingRate) * 100).toFixed(1)}%`,
      treatyBenefit: profile.hasTreaty,
      treatyReduction: profile.hasTreaty ? `${((profile.withholdingRate - profile.treatyRate) * 100).toFixed(1)}% reduction` : 'No treaty',
    },
    usTax: {
      grossTaxBeforeCredit: usTaxBeforeCredit,
      foreignTaxCredit,
      netUsTaxOwed: netUsTax,
      totalEffectiveTaxRate: `${(((foreignIncomeTax + netUsTax) / netRentalIncome) * 100).toFixed(1)}%`,
    },
    firpta: {
      applies: profile.firptaLike,
      estimatedGain,
      withholdingOnSale: firptaWithholding,
      actualTax: actualCapGainsTax,
      refundDue: Math.max(0, firptaWithholding - actualCapGainsTax),
      note: 'FIRPTA requires 15% withholding on gross sale price of US real property by foreign persons. For US persons selling foreign property, local equivalent rules may apply.',
    },
    reporting: {
      fbarRequired,
      fbarThreshold: '$10,000 aggregate foreign accounts',
      fatcaRequired,
      fatcaForm: 'Form 8938',
      form5471: usPersonType !== 'individual' ? 'Required for US shareholders of foreign corporations' : 'N/A',
      form8865: 'Required if holding through foreign partnership',
      scheduleB: 'Must disclose foreign accounts on Schedule B',
    },
    strategies: [
      profile.hasTreaty ? `${profile.name} has a US tax treaty — claim reduced withholding rate of ${(profile.treatyRate * 100).toFixed(0)}%` : `No US tax treaty with ${profile.name} — full withholding applies`,
      foreignIncomeTax > usTaxBeforeCredit ? `Foreign tax credit fully offsets US tax — no additional US tax on rental income` : `Partial foreign tax credit of $${foreignTaxCredit.toLocaleString()} against $${usTaxBeforeCredit.toLocaleString()} US tax`,
      'Consider holding through a US LLC to simplify reporting (disregarded entity for US tax)',
      'File FinCEN 114 (FBAR) by April 15 with automatic extension to October 15',
      holdingYears >= 5 ? 'Long holding period may qualify for preferential local capital gains rates' : 'Consider holding 5+ years for local capital gains benefits',
    ],
  }
}

// ============================================================================
// Transfer Pricing Analysis
// ============================================================================

export async function analyzeTransferPricing(params: Record<string, unknown>) {
  const managementEntity = (params.management_entity as string) || 'US LLC'
  const operatingEntity = (params.operating_entity as string) || 'Mexico S. de R.L.'
  const managementCountry = (params.management_country as string) || 'US'
  const operatingCountry = (params.operating_country as string) || 'Mexico'
  const totalRevenue = (params.total_revenue as number) || 500_000
  const managementFeePercent = (params.management_fee_percent as number) || 15
  const ipLicenseFeePercent = (params.ip_license_fee_percent as number) || 5
  const numberOfProperties = (params.number_of_properties as number) || 3
  const employeesManagement = (params.employees_management as number) || 2
  const employeesOperating = (params.employees_operating as number) || 8

  const managementFee = Math.round(totalRevenue * managementFeePercent / 100)
  const ipLicenseFee = Math.round(totalRevenue * ipLicenseFeePercent / 100)
  const totalIntercompany = managementFee + ipLicenseFee

  // Arm's length benchmarking
  const marketManagementRange = { low: 8, mid: 12, high: 18 }
  const marketIPRange = { low: 2, mid: 5, high: 8 }
  const managementInRange = managementFeePercent >= marketManagementRange.low && managementFeePercent <= marketManagementRange.high
  const ipInRange = ipLicenseFeePercent >= marketIPRange.low && ipLicenseFeePercent <= marketIPRange.high

  // Tax impact
  const usTaxRate = 0.21 // corporate or effective
  const foreignTaxRate = 0.30 // Mexico corporate
  const taxOnManagementFee = Math.round(managementFee * usTaxRate)
  const taxSavedForeign = Math.round(managementFee * foreignTaxRate)
  const netTaxBenefit = taxSavedForeign - taxOnManagementFee

  // Risk assessment
  const riskLevel = managementFeePercent > marketManagementRange.high || ipLicenseFeePercent > marketIPRange.high ? 'HIGH' :
    managementFeePercent > marketManagementRange.mid + 3 || ipLicenseFeePercent > marketIPRange.mid + 2 ? 'MEDIUM' : 'LOW'

  return {
    entities: {
      management: { name: managementEntity, country: managementCountry, employees: employeesManagement, role: 'Strategic management, booking platform, marketing, accounting' },
      operating: { name: operatingEntity, country: operatingCountry, employees: employeesOperating, role: 'On-ground operations, cleaning, maintenance, guest services', properties: numberOfProperties },
    },
    intercompanyTransactions: {
      managementFee: { amount: managementFee, percent: `${managementFeePercent}%`, description: 'Strategic management and centralized services' },
      ipLicenseFee: { amount: ipLicenseFee, percent: `${ipLicenseFeePercent}%`, description: 'Brand, booking platform, and proprietary systems' },
      total: totalIntercompany,
      percentOfRevenue: `${((totalIntercompany / totalRevenue) * 100).toFixed(1)}%`,
    },
    armLengthBenchmark: {
      managementFee: {
        marketRange: `${marketManagementRange.low}-${marketManagementRange.high}%`,
        currentRate: `${managementFeePercent}%`,
        status: managementInRange ? 'WITHIN RANGE' : 'OUTSIDE RANGE',
        method: 'Comparable Uncontrolled Transaction (CUT)',
      },
      ipLicenseFee: {
        marketRange: `${marketIPRange.low}-${marketIPRange.high}%`,
        currentRate: `${ipLicenseFeePercent}%`,
        status: ipInRange ? 'WITHIN RANGE' : 'OUTSIDE RANGE',
        method: 'Comparable Profits Method (CPM)',
      },
    },
    taxImpact: {
      managementFeeTaxInUS: taxOnManagementFee,
      taxDeductionAbroad: taxSavedForeign,
      netAnnualBenefit: netTaxBenefit,
      fiveYearBenefit: netTaxBenefit * 5,
    },
    riskAssessment: {
      overallRisk: riskLevel,
      factors: [
        { factor: 'Management fee rate', risk: managementInRange ? 'LOW' : 'HIGH', detail: `${managementFeePercent}% vs market ${marketManagementRange.low}-${marketManagementRange.high}%` },
        { factor: 'IP license rate', risk: ipInRange ? 'LOW' : 'HIGH', detail: `${ipLicenseFeePercent}% vs market ${marketIPRange.low}-${marketIPRange.high}%` },
        { factor: 'Economic substance', risk: employeesManagement >= 2 ? 'LOW' : 'HIGH', detail: `${employeesManagement} employees in management entity` },
        { factor: 'Documentation', risk: 'MEDIUM', detail: 'Transfer pricing study recommended' },
      ],
    },
    documentation: {
      required: [
        'Master file (group-wide overview)',
        'Local file (entity-level TP analysis)',
        'Country-by-Country Report (if group revenue > $850M)',
        'Contemporaneous documentation of methodology',
        'Benchmark study with comparable transactions',
      ],
      deadline: 'Due with annual tax return; maintain for 7 years',
      penalties: `Failure to document: 20-40% penalty on transfer pricing adjustments in ${operatingCountry}`,
    },
    recommendations: [
      !managementInRange ? `Adjust management fee to ${marketManagementRange.mid}% (within arm\'s length range) to reduce audit risk` : 'Management fee is within arm\'s length range',
      !ipInRange ? `Adjust IP license fee to ${marketIPRange.mid}% to align with market benchmarks` : 'IP license fee is within range',
      'Commission a formal transfer pricing study for penalty protection',
      'Implement intercompany agreements with detailed service descriptions',
      netTaxBenefit > 10_000 ? `Current structure provides $${netTaxBenefit.toLocaleString()}/yr net tax benefit — ensure economic substance supports allocation` : null,
    ].filter(Boolean),
  }
}

// ============================================================================
// Entity Structure Recommendation
// ============================================================================

export async function recommendEntityStructure(ownerId: string) {
  const owner = await getOwner(ownerId)
  if (!owner) throw new Error(`Owner ${ownerId} not found`)

  const entities = await getAllEntitiesByOwner(ownerId)
  let totalSTRNet = 0

  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id)
    totalSTRNet += pnl.netIncome
  }

  // S-Corp analysis — beneficial when SE tax savings exceed additional costs
  const seTax = calculateSETax(totalSTRNet)
  const reasonableSalary = Math.min(totalSTRNet * 0.4, 80_000) // conservative
  const sCorpSETax = calculateSETax(reasonableSalary)
  const sCorpSavings = seTax.totalSETax - sCorpSETax.totalSETax
  const sCorpCosts = 3_000 // est. annual compliance cost

  const recommendation = totalSTRNet > 60_000 && sCorpSavings > sCorpCosts
    ? 's_corp'
    : 'schedule_e'

  return {
    owner: { name: owner.name, filingStatus: owner.filingStatus },
    currentSTRIncome: totalSTRNet,
    analysis: {
      scheduleE: {
        selfEmploymentTax: seTax.totalSETax,
        pros: ['Simple filing', 'No payroll', 'No additional entity costs'],
        cons: ['Full SE tax on net income', 'No wage/distribution split'],
      },
      sCorp: {
        reasonableSalary,
        distributionIncome: totalSTRNet - reasonableSalary,
        selfEmploymentTax: sCorpSETax.totalSETax,
        annualSavings: sCorpSavings - sCorpCosts,
        complianceCost: sCorpCosts,
        pros: ['SE tax only on salary portion', `Potential savings of $${(sCorpSavings - sCorpCosts).toLocaleString()}/yr`],
        cons: ['Payroll setup required', `~$${sCorpCosts.toLocaleString()}/yr compliance costs`, 'Reasonable salary must be justified'],
      },
    },
    recommendation,
    reasoning: recommendation === 's_corp'
      ? `With $${totalSTRNet.toLocaleString()} in STR net income, S-Corp election saves approximately $${(sCorpSavings - sCorpCosts).toLocaleString()}/yr after compliance costs.`
      : `With $${totalSTRNet.toLocaleString()} in STR net income, Schedule E is simpler and the S-Corp savings don't justify the added complexity.`,
  }
}

// ============================================================================
// State Sales Tax Nexus Analysis
// ============================================================================

export async function analyzeSalesTaxNexus(params: Record<string, unknown>) {
  const states = (params.states as string[]) || ['CA', 'TX', 'FL', 'NY', 'CO', 'TN']
  const annualSTRRevenue = (params.annual_str_revenue as number) || 120_000
  const numberOfProperties = (params.number_of_properties as number) || 3
  const platformsUsed = (params.platforms as string[]) || ['Airbnb', 'VRBO', 'Direct']
  const averageNightlyRate = (params.avg_nightly_rate as number) || 200

  // State STR/occupancy tax rules (simplified)
  const stateRules: Record<string, { occupancyTax: number; salesTax: number; strRegistration: boolean; platformCollects: boolean; localTaxes: boolean; nexusThreshold: number; name: string }> = {
    CA: { occupancyTax: 0.12, salesTax: 0.0725, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 500_000, name: 'California' },
    TX: { occupancyTax: 0.06, salesTax: 0.0625, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 500_000, name: 'Texas' },
    FL: { occupancyTax: 0.06, salesTax: 0.06, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 100_000, name: 'Florida' },
    NY: { occupancyTax: 0.0575, salesTax: 0.04, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 500_000, name: 'New York' },
    CO: { occupancyTax: 0.04, salesTax: 0.029, strRegistration: true, platformCollects: false, localTaxes: true, nexusThreshold: 100_000, name: 'Colorado' },
    TN: { occupancyTax: 0.05, salesTax: 0.07, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 500_000, name: 'Tennessee' },
    HI: { occupancyTax: 0.1025, salesTax: 0.04, strRegistration: true, platformCollects: false, localTaxes: true, nexusThreshold: 100_000, name: 'Hawaii' },
    AZ: { occupancyTax: 0.055, salesTax: 0.056, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 200_000, name: 'Arizona' },
    SC: { occupancyTax: 0.07, salesTax: 0.06, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 100_000, name: 'South Carolina' },
    OR: { occupancyTax: 0.015, salesTax: 0, strRegistration: true, platformCollects: false, localTaxes: true, nexusThreshold: 0, name: 'Oregon' },
    NV: { occupancyTax: 0.12, salesTax: 0.0685, strRegistration: true, platformCollects: true, localTaxes: true, nexusThreshold: 100_000, name: 'Nevada' },
    MT: { occupancyTax: 0.04, salesTax: 0, strRegistration: true, platformCollects: false, localTaxes: true, nexusThreshold: 0, name: 'Montana' },
  }

  const revenuePerState = annualSTRRevenue / states.length // simplified even split

  const stateAnalysis = states.map(st => {
    const rules = stateRules[st] || { occupancyTax: 0.05, salesTax: 0.05, strRegistration: true, platformCollects: false, localTaxes: true, nexusThreshold: 100_000, name: st }
    const hasNexus = revenuePerState > 0 // physical presence = nexus for STR
    const estimatedOccupancyTax = Math.round(revenuePerState * rules.occupancyTax)
    const estimatedSalesTax = Math.round(revenuePerState * rules.salesTax)
    const estimatedLocalTax = rules.localTaxes ? Math.round(revenuePerState * 0.03) : 0 // avg local surcharge

    return {
      state: st,
      stateName: rules.name,
      hasNexus,
      nexusType: 'Physical presence (property located in state)',
      occupancyTaxRate: `${(rules.occupancyTax * 100).toFixed(1)}%`,
      salesTaxRate: `${(rules.salesTax * 100).toFixed(2)}%`,
      estimatedOccupancyTax,
      estimatedSalesTax,
      estimatedLocalTax,
      totalEstimatedTax: estimatedOccupancyTax + estimatedSalesTax + estimatedLocalTax,
      platformCollects: rules.platformCollects,
      registrationRequired: rules.strRegistration,
      complianceActions: [
        rules.strRegistration ? `Register for ${rules.name} STR/occupancy tax permit` : null,
        !rules.platformCollects ? `Must self-collect and remit occupancy tax (${(rules.occupancyTax * 100).toFixed(1)}%)` : `Airbnb/VRBO collects state occupancy tax automatically`,
        rules.localTaxes ? `Check county/city for additional local lodging taxes` : null,
        `File ${rules.name} sales/occupancy tax returns (typically quarterly)`,
      ].filter(Boolean),
    }
  })

  const totalAnnualTaxLiability = stateAnalysis.reduce((sum, s) => sum + s.totalEstimatedTax, 0)

  return {
    summary: {
      statesAnalyzed: states.length,
      totalAnnualSTRRevenue: annualSTRRevenue,
      totalEstimatedTaxLiability: totalAnnualTaxLiability,
      effectiveTaxRate: `${((totalAnnualTaxLiability / annualSTRRevenue) * 100).toFixed(1)}%`,
      statesRequiringRegistration: stateAnalysis.filter(s => s.registrationRequired).length,
      statesRequiringSelfCollection: stateAnalysis.filter(s => !s.platformCollects).length,
    },
    stateAnalysis,
    platformCoverage: {
      airbnb: 'Collects occupancy tax in most states — verify per-state coverage',
      vrbo: 'Collects in fewer states than Airbnb — more self-remittance required',
      direct: 'Operator must collect and remit ALL applicable taxes',
    },
    deadlines: {
      quarterlyFiling: 'Most states require quarterly occupancy tax returns',
      annualRegistration: 'Renew STR permits annually in most jurisdictions',
      penaltyForNonCompliance: 'Typically 5-25% penalty + interest on uncollected taxes',
    },
    recommendations: [
      'Register for occupancy tax permits in all states where properties are located',
      stateAnalysis.some(s => !s.platformCollects) ? 'Set aside estimated taxes monthly for self-collection states' : null,
      'Consider using a tax automation service (Avalara, TaxJar) for multi-state compliance',
      platformsUsed.includes('Direct') ? 'Direct bookings require YOU to collect all taxes — build into pricing' : null,
      `Total estimated tax burden: $${totalAnnualTaxLiability.toLocaleString()}/yr (${((totalAnnualTaxLiability / annualSTRRevenue) * 100).toFixed(1)}% of revenue)`,
    ].filter(Boolean),
  }
}

// ============================================================================
// Business Return Filing Readiness
// ============================================================================

export async function analyzeBusinessReturn(params: Record<string, unknown>) {
  const ownerId = (params.owner_id as string) || 'owner-01'
  const taxYear = (params.tax_year as number) || 2025
  const entityType = (params.entity_type as string) || 'llc'

  const owner = await getOwner(ownerId)
  const entities = await getAllEntitiesByOwner(ownerId)

  let totalRevenue = 0
  let totalExpenses = 0
  const entityDetails = []

  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id, entity.name)
    totalRevenue += pnl.revenue
    totalExpenses += pnl.expenses
    const properties = await getPropertiesByEntity(entity.id)

    entityDetails.push({
      entity: entity.name,
      type: entity.type,
      ein: entity.ein || 'Not assigned',
      revenue: Math.round(pnl.revenue),
      expenses: Math.round(pnl.expenses),
      netIncome: Math.round(pnl.netIncome),
      propertyCount: properties.length,
      form: entity.type === 's_corp' ? 'Form 1120-S' : entity.type === 'partnership' ? 'Form 1065' : 'Schedule E / Schedule C',
    })
  }

  const netIncome = totalRevenue - totalExpenses

  // Determine required forms
  const forms: { form: string; description: string; deadline: string; status: string }[] = []

  for (const entity of entities) {
    if (entity.type === 's_corp') {
      forms.push({ form: 'Form 1120-S', description: `S-Corp return for ${entity.name}`, deadline: `March 15, ${taxYear + 1}`, status: entity.ein ? 'Ready' : 'Needs EIN' })
      forms.push({ form: 'Schedule K-1', description: `K-1 distribution for each shareholder`, deadline: `March 15, ${taxYear + 1}`, status: 'Pending' })
    } else if (entity.type === 'partnership') {
      forms.push({ form: 'Form 1065', description: `Partnership return for ${entity.name}`, deadline: `March 15, ${taxYear + 1}`, status: entity.ein ? 'Ready' : 'Needs EIN' })
      forms.push({ form: 'Schedule K-1', description: `K-1 for each partner`, deadline: `March 15, ${taxYear + 1}`, status: 'Pending' })
    }
  }

  forms.push({ form: 'Schedule E', description: 'Rental real estate income/loss', deadline: `April 15, ${taxYear + 1}`, status: totalRevenue > 0 ? 'Data available' : 'No activity' })

  if (netIncome > 400) {
    forms.push({ form: 'Schedule SE', description: 'Self-employment tax', deadline: `April 15, ${taxYear + 1}`, status: 'Required' })
  }

  // Checklist
  const checklist = [
    { item: 'All 1099s received (1099-K, 1099-MISC, 1099-NEC)', status: 'Verify', priority: 'HIGH' },
    { item: 'Platform income reports downloaded (Airbnb, VRBO)', status: 'Verify', priority: 'HIGH' },
    { item: 'All expense receipts organized', status: totalExpenses > 0 ? 'Partial' : 'Not started', priority: 'HIGH' },
    { item: 'Mileage log for property visits', status: 'Verify', priority: 'MEDIUM' },
    { item: 'Home office deduction calculation', status: 'Optional', priority: 'LOW' },
    { item: 'Depreciation schedules current', status: 'Verify', priority: 'HIGH' },
    { item: 'Material participation hours documented', status: 'Verify', priority: 'HIGH' },
    { item: 'Estimated tax payments reconciled', status: 'Verify', priority: 'MEDIUM' },
    { item: 'State filing requirements identified', status: 'Verify', priority: 'MEDIUM' },
    { item: 'EINs confirmed for all entities', status: entities.every(e => e.ein) ? 'Complete' : 'Incomplete', priority: 'HIGH' },
  ]

  return {
    taxYear,
    owner: owner ? { name: owner.name, filingStatus: owner.filingStatus } : { name: 'Unknown', filingStatus: 'single' },
    entities: entityDetails,
    financialSummary: {
      totalRevenue: Math.round(totalRevenue),
      totalExpenses: Math.round(totalExpenses),
      netIncome: Math.round(netIncome),
      estimatedSETax: netIncome > 400 ? Math.round(netIncome * 0.153) : 0,
    },
    requiredForms: forms,
    filingChecklist: checklist,
    deadlines: {
      sCorpPartnership: `March 15, ${taxYear + 1}`,
      personal: `April 15, ${taxYear + 1}`,
      extensionDeadline: `October 15, ${taxYear + 1}`,
      estimatedTaxQ1: `April 15, ${taxYear + 1}`,
    },
    recommendations: [
      entities.some(e => e.type === 's_corp' || e.type === 'partnership') ? `File entity returns by March 15 — K-1s needed for personal return` : null,
      netIncome > 50_000 ? 'Consider quarterly estimated tax payments to avoid underpayment penalty' : null,
      'Reconcile all platform 1099-Ks with your actual revenue records',
      'Ensure depreciation is being claimed on all eligible property improvements',
      `Review ${taxYear} tax law changes that may affect your filing`,
    ].filter(Boolean),
  }
}

// ============================================================================
// Personal Return Optimization
// ============================================================================

export async function analyzePersonalReturnOptimization(params: Record<string, unknown>) {
  const ownerId = (params.owner_id as string) || 'owner-01'
  const taxYear = (params.tax_year as number) || 2025

  const owner = await getOwner(ownerId)
  if (!owner) throw new Error(`Owner ${ownerId} not found`)

  const entities = await getAllEntitiesByOwner(ownerId)
  let totalSTRNet = 0
  let totalDepreciation = 0

  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id, entity.name)
    totalSTRNet += pnl.netIncome
    // Estimate depreciation from ledger
    const depEntries = entries.filter(e => e.accountCode === '6800')
    totalDepreciation += depEntries.reduce((sum, e) => sum + e.debit, 0)
  }

  const totalAGI = owner.w2Income + totalSTRNet
  const standardDeduction = owner.filingStatus === 'married_joint' ? 30_000 : 15_000

  // Check for missed deductions and optimization opportunities
  const opportunities: { category: string; description: string; estimatedSavings: number; action: string; priority: string }[] = []

  // QBI deduction
  const qbiDeduction = Math.min(totalSTRNet * 0.20, totalAGI * 0.20)
  if (totalSTRNet > 0 && totalAGI < (owner.filingStatus === 'married_joint' ? 383_900 : 191_950)) {
    opportunities.push({
      category: 'QBI Deduction',
      description: `20% deduction on qualified business income ($${totalSTRNet.toLocaleString()})`,
      estimatedSavings: Math.round(qbiDeduction * 0.24),
      action: 'Ensure all STR income qualifies — document material participation',
      priority: 'HIGH',
    })
  }

  // Depreciation
  if (totalDepreciation === 0 && entities.length > 0) {
    opportunities.push({
      category: 'Depreciation',
      description: 'No depreciation claimed — residential rental property depreciates over 27.5 years',
      estimatedSavings: Math.round(500_000 / 27.5 * 0.24), // estimate on $500k basis
      action: 'Calculate depreciable basis and begin claiming annual depreciation',
      priority: 'HIGH',
    })
  }

  // Cost segregation
  if (totalSTRNet > 50_000) {
    opportunities.push({
      category: 'Cost Segregation',
      description: 'Accelerate depreciation by reclassifying building components to 5, 7, or 15-year life',
      estimatedSavings: Math.round(totalSTRNet * 0.15),
      action: 'Commission a cost segregation study for properties > $500k',
      priority: 'MEDIUM',
    })
  }

  // Retirement contributions
  const maxSoloContribution = Math.min(totalSTRNet * 0.20, 69_000)
  if (totalSTRNet > 20_000) {
    opportunities.push({
      category: 'Retirement',
      description: `Solo 401(k) or SEP-IRA contribution (up to $${maxSoloContribution.toLocaleString()})`,
      estimatedSavings: Math.round(maxSoloContribution * 0.24),
      action: 'Open Solo 401(k) before Dec 31; fund by tax filing deadline',
      priority: 'HIGH',
    })
  }

  // HSA
  if (owner.filingStatus === 'married_joint') {
    opportunities.push({
      category: 'HSA',
      description: 'Health Savings Account — $8,300 family deduction (2025)',
      estimatedSavings: Math.round(8_300 * 0.24),
      action: 'Contribute to HSA if enrolled in high-deductible health plan',
      priority: 'MEDIUM',
    })
  }

  // Charitable / Donor-Advised Fund
  if (totalAGI > 200_000) {
    opportunities.push({
      category: 'Charitable Giving',
      description: 'Bunch charitable deductions via Donor-Advised Fund to exceed standard deduction',
      estimatedSavings: Math.round(10_000 * 0.32),
      action: 'Fund DAF before Dec 31 with appreciated securities to avoid capital gains',
      priority: 'MEDIUM',
    })
  }

  // Real Estate Professional Status
  opportunities.push({
    category: 'RE Professional Status',
    description: '750+ hours in real estate = unlimited passive loss deductions against W-2 income',
    estimatedSavings: totalSTRNet < 0 ? Math.round(Math.abs(totalSTRNet) * 0.24) : 0,
    action: 'Track hours meticulously — must exceed time spent in W-2 job',
    priority: totalSTRNet < 0 ? 'HIGH' : 'LOW',
  })

  const totalPotentialSavings = opportunities.reduce((sum, o) => sum + o.estimatedSavings, 0)

  return {
    taxYear,
    owner: { name: owner.name, filingStatus: owner.filingStatus, w2Income: owner.w2Income },
    currentPosition: {
      w2Income: owner.w2Income,
      strNetIncome: Math.round(totalSTRNet),
      totalAGI: Math.round(totalAGI),
      standardDeduction,
      taxableIncome: Math.round(Math.max(0, totalAGI - standardDeduction)),
    },
    optimizationOpportunities: opportunities.sort((a, b) => b.estimatedSavings - a.estimatedSavings),
    totalPotentialSavings,
    itemizedVsStandard: {
      standardDeduction,
      estimatedItemized: Math.round(totalDepreciation + (totalAGI > 200_000 ? 15_000 : 5_000)), // rough SALT + mortgage
      recommendation: totalDepreciation + 15_000 > standardDeduction ? 'Itemize' : 'Standard deduction',
    },
    actionPlan: [
      ...opportunities.filter(o => o.priority === 'HIGH').map(o => `[HIGH] ${o.action}`),
      ...opportunities.filter(o => o.priority === 'MEDIUM').map(o => `[MEDIUM] ${o.action}`),
    ],
  }
}

// ============================================================================
// Personal Return Filing Guide
// ============================================================================

export async function analyzePersonalReturnFiling(params: Record<string, unknown>) {
  const ownerId = (params.owner_id as string) || 'owner-01'
  const taxYear = (params.tax_year as number) || 2025
  const extensionFiled = (params.extension_filed as boolean) || false

  const owner = await getOwner(ownerId)
  const entities = await getAllEntitiesByOwner(ownerId)

  let totalSTRNet = 0
  const schedules: string[] = ['Schedule E (Rental Income)']

  for (const entity of entities) {
    const entries = await getLedgerByEntity(entity.id)
    const pnl = getEntityPnL(entries, entity.id, entity.name)
    totalSTRNet += pnl.netIncome

    if (entity.type === 's_corp') schedules.push('Schedule K-1 (S-Corp)')
    if (entity.type === 'partnership') schedules.push('Schedule K-1 (Partnership)')
  }

  if (totalSTRNet > 400) schedules.push('Schedule SE (Self-Employment Tax)')
  if (owner && owner.w2Income > 0) schedules.push('W-2 (Wages)')
  schedules.push('Schedule B (Interest/Dividends)')

  const now = new Date()
  const filingDeadline = new Date(`${taxYear + 1}-04-15`)
  const extensionDeadline = new Date(`${taxYear + 1}-10-15`)
  const daysUntilDeadline = Math.max(0, Math.ceil((filingDeadline.getTime() - now.getTime()) / 86400000))
  const daysUntilExtension = Math.max(0, Math.ceil((extensionDeadline.getTime() - now.getTime()) / 86400000))

  const totalAGI = (owner?.w2Income || 0) + totalSTRNet
  const urgency = daysUntilDeadline <= 0 ? 'OVERDUE' : daysUntilDeadline <= 14 ? 'URGENT' : daysUntilDeadline <= 45 ? 'SOON' : 'ON TRACK'

  return {
    taxYear,
    owner: owner ? { name: owner.name, filingStatus: owner.filingStatus } : { name: 'Unknown' },
    filingStatus: {
      urgency,
      daysUntilDeadline,
      filingDeadline: filingDeadline.toISOString().split('T')[0],
      extensionDeadline: extensionDeadline.toISOString().split('T')[0],
      extensionFiled,
      daysUntilExtension,
    },
    form1040Walkthrough: [
      { line: 'Line 1', description: 'Wages (W-2)', amount: owner?.w2Income || 0, source: 'W-2 from employer' },
      { line: 'Line 8', description: 'Other income (Schedule E rental)', amount: Math.round(totalSTRNet), source: 'Schedule E' },
      { line: 'Line 9', description: 'Total income', amount: Math.round(totalAGI), source: 'Sum of all income' },
      { line: 'Line 12', description: 'Standard/Itemized deduction', amount: owner?.filingStatus === 'married_joint' ? 30_000 : 15_000, source: 'Standard deduction' },
      { line: 'Line 13', description: 'QBI deduction (if eligible)', amount: Math.round(Math.min(totalSTRNet * 0.20, totalAGI * 0.20)), source: 'Form 8995' },
      { line: 'Line 15', description: 'Taxable income', amount: Math.round(Math.max(0, totalAGI - (owner?.filingStatus === 'married_joint' ? 30_000 : 15_000))), source: 'Calculated' },
    ],
    requiredSchedules: [...new Set(schedules)],
    documentsNeeded: [
      { document: 'W-2', description: 'Wage and tax statement from employer', have: owner && owner.w2Income > 0 ? 'Likely' : 'N/A' },
      { document: '1099-K', description: 'Platform income (Airbnb, VRBO)', have: 'Verify' },
      { document: '1099-INT', description: 'Bank interest income', have: 'Verify' },
      { document: '1098', description: 'Mortgage interest statement', have: 'Verify' },
      { document: 'Property tax bills', description: 'For Schedule E deduction', have: 'Verify' },
      { document: 'Insurance declarations', description: 'For Schedule E deduction', have: 'Verify' },
      { document: 'Depreciation schedule', description: 'Form 4562', have: 'Verify' },
      { document: 'Estimated tax payments', description: 'Form 1040-ES receipts', have: 'Verify' },
    ],
    extensionAnalysis: {
      shouldExtend: daysUntilDeadline <= 14 && !extensionFiled,
      extensionForm: 'Form 4868',
      extensionDeadline: extensionDeadline.toISOString().split('T')[0],
      note: 'Extension gives more time to FILE, not to PAY — estimate and pay taxes by April 15',
      estimatedTaxDue: Math.round(totalAGI * 0.22), // rough estimate
    },
    estimatedPayments: {
      q1: { due: `April 15, ${taxYear}`, amount: Math.round(totalAGI * 0.22 / 4) },
      q2: { due: `June 15, ${taxYear}`, amount: Math.round(totalAGI * 0.22 / 4) },
      q3: { due: `September 15, ${taxYear}`, amount: Math.round(totalAGI * 0.22 / 4) },
      q4: { due: `January 15, ${taxYear + 1}`, amount: Math.round(totalAGI * 0.22 / 4) },
    },
    nextSteps: [
      urgency === 'OVERDUE' ? 'FILE IMMEDIATELY — penalties accrue daily' : null,
      urgency === 'URGENT' && !extensionFiled ? 'File Form 4868 extension TODAY and pay estimated tax due' : null,
      'Gather all W-2s, 1099s, and 1098s',
      'Reconcile platform income with 1099-K',
      'Calculate depreciation for all rental properties',
      'Document material participation hours',
      totalSTRNet > 0 ? 'Calculate QBI deduction eligibility' : null,
      'Review estimated tax payments made during the year',
      'Choose: self-file (TurboTax/FreeTaxUSA) or hire CPA',
    ].filter(Boolean),
  }
}
