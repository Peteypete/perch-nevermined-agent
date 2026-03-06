// High-level analysis functions — Property, Portfolio, Entity Recommendation

import { db } from '../firebase/config.js'
import type { Owner, Entity, Property, LedgerEntry } from '../types.js'
import { CHART_OF_ACCOUNTS } from '../types.js'
import { calculateNOI, getEntityPnL } from './trial-balance.js'
import {
  projectTaxLiability,
  calculateQBIDeduction,
  calculateMaterialParticipation,
  calculateSETax,
  type FilingStatus,
} from './tax-engine.js'

// ============================================================================
// Firebase Query Helpers
// ============================================================================

async function getOwner(ownerId: string): Promise<Owner | null> {
  const doc = await db.collection('owners').doc(ownerId).get()
  return doc.exists ? (doc.data() as Owner) : null
}

async function getEntity(entityId: string): Promise<Entity | null> {
  const doc = await db.collection('entities').doc(entityId).get()
  return doc.exists ? (doc.data() as Entity) : null
}

async function getProperty(propertyId: string): Promise<Property | null> {
  const doc = await db.collection('properties').doc(propertyId).get()
  return doc.exists ? (doc.data() as Property) : null
}

async function getPropertiesByEntity(entityId: string): Promise<Property[]> {
  const snap = await db.collection('properties').where('entityId', '==', entityId).get()
  return snap.docs.map(d => d.data() as Property)
}

async function getLedgerByEntity(entityId: string): Promise<LedgerEntry[]> {
  const snap = await db.collection('ledger').where('entityId', '==', entityId).get()
  return snap.docs.map(d => d.data() as LedgerEntry)
}

async function getLedgerByProperty(propertyId: string): Promise<LedgerEntry[]> {
  const snap = await db.collection('ledger').where('propertyId', '==', propertyId).get()
  return snap.docs.map(d => d.data() as LedgerEntry)
}

async function getAllEntitiesByOwner(ownerId: string): Promise<Entity[]> {
  const snap = await db.collection('entities').where('ownerId', '==', ownerId).get()
  return snap.docs.map(d => d.data() as Entity)
}

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

export async function analyzeTaxProjection(ownerId: string) {
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

  return {
    owner: { name: owner.name, filingStatus: owner.filingStatus, w2Income: owner.w2Income },
    entities: entityDetails,
    taxProjection: projection,
  }
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
