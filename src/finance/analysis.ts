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
