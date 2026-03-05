// Trial Balance Engine — Double-entry ledger, NOI, Entity P&L

import type { LedgerEntry, Property } from '../types.js'
import { CHART_OF_ACCOUNTS } from '../types.js'

// ============================================================================
// Trial Balance Aggregation
// ============================================================================

export interface TrialBalanceRow {
  accountCode: string
  accountName: string
  type: 'revenue' | 'expense'
  scheduleELine: string
  totalDebit: number
  totalCredit: number
  balance: number // positive = debit balance, negative = credit balance
}

export function aggregateTrialBalance(entries: LedgerEntry[]): TrialBalanceRow[] {
  const accountMap = new Map<string, { debit: number; credit: number }>()

  for (const entry of entries) {
    const existing = accountMap.get(entry.accountCode) ?? { debit: 0, credit: 0 }
    existing.debit += entry.debit
    existing.credit += entry.credit
    accountMap.set(entry.accountCode, existing)
  }

  const rows: TrialBalanceRow[] = []
  for (const [code, totals] of accountMap) {
    const account = CHART_OF_ACCOUNTS[code]
    if (!account) continue
    rows.push({
      accountCode: code,
      accountName: account.name,
      type: account.type,
      scheduleELine: account.scheduleELine,
      totalDebit: Math.round(totals.debit * 100) / 100,
      totalCredit: Math.round(totals.credit * 100) / 100,
      balance: Math.round((totals.debit - totals.credit) * 100) / 100,
    })
  }

  return rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode))
}

// ============================================================================
// NOI (Net Operating Income)
// ============================================================================

export interface NOIResult {
  propertyId?: string
  propertyName?: string
  totalRevenue: number
  totalExpenses: number
  noi: number
  noiMargin: number
  revenueBreakdown: { account: string; amount: number }[]
  expenseBreakdown: { account: string; amount: number }[]
}

export function calculateNOI(entries: LedgerEntry[], property?: Property): NOIResult {
  const tb = aggregateTrialBalance(entries)

  const revenueRows = tb.filter(r => r.type === 'revenue')
  const expenseRows = tb.filter(r => r.type === 'expense')

  const totalRevenue = revenueRows.reduce((sum, r) => sum + r.totalCredit, 0)
  const totalExpenses = expenseRows.reduce((sum, r) => sum + r.totalDebit, 0)
  const noi = totalRevenue - totalExpenses

  return {
    propertyId: property?.id,
    propertyName: property?.name,
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    noi: Math.round(noi * 100) / 100,
    noiMargin: totalRevenue > 0 ? Math.round((noi / totalRevenue) * 10000) / 100 : 0,
    revenueBreakdown: revenueRows.map(r => ({ account: r.accountName, amount: r.totalCredit })),
    expenseBreakdown: expenseRows.map(r => ({ account: r.accountName, amount: r.totalDebit })),
  }
}

// ============================================================================
// Entity P&L
// ============================================================================

export interface EntityPnL {
  entityId: string
  entityName?: string
  revenue: number
  expenses: number
  netIncome: number
  trialBalance: TrialBalanceRow[]
  scheduleESummary: Record<string, number> // line -> amount
}

export function getEntityPnL(entries: LedgerEntry[], entityId: string, entityName?: string): EntityPnL {
  const entityEntries = entries.filter(e => e.entityId === entityId)
  const tb = aggregateTrialBalance(entityEntries)

  const revenue = tb.filter(r => r.type === 'revenue').reduce((sum, r) => sum + r.totalCredit, 0)
  const expenses = tb.filter(r => r.type === 'expense').reduce((sum, r) => sum + r.totalDebit, 0)

  // Build Schedule E summary
  const scheduleESummary: Record<string, number> = {}
  for (const row of tb) {
    const amount = row.type === 'revenue' ? row.totalCredit : row.totalDebit
    if (amount > 0) {
      scheduleESummary[row.scheduleELine] = (scheduleESummary[row.scheduleELine] ?? 0) + amount
    }
  }

  return {
    entityId,
    entityName,
    revenue: Math.round(revenue * 100) / 100,
    expenses: Math.round(expenses * 100) / 100,
    netIncome: Math.round((revenue - expenses) * 100) / 100,
    trialBalance: tb,
    scheduleESummary,
  }
}
