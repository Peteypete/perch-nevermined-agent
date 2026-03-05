// Perch Tax & Finance Expert Agent — Shared Types

// ============================================================================
// Firebase / Data Models
// ============================================================================

export interface Owner {
  id: string
  name: string
  email: string
  w2Income: number
  filingStatus: 'single' | 'married_joint' | 'married_separate' | 'head_of_household'
  entities: string[] // entity IDs
}

export interface Entity {
  id: string
  ownerId: string
  name: string
  type: 'llc' | 'schedule_e' | 's_corp' | 'partnership'
  ein?: string
  properties: string[] // property IDs
}

export interface Property {
  id: string
  entityId: string
  name: string
  address: string
  city: string
  state: string
  nightlyRate: number
  cleaningFee: number
  avgOccupancy: number // 0-1
  monthlyExpenses: number
  purchasePrice: number
  purchaseDate: string
  depreciationBasis: number
  materialParticipationHours: number
  ytdRevenue: number
  ytdExpenses: number
  status: 'active' | 'inactive'
}

export interface LedgerEntry {
  id: string
  entityId: string
  propertyId?: string
  date: string
  accountCode: string
  accountName: string
  description: string
  debit: number
  credit: number
  category: string
}

// ============================================================================
// Chart of Accounts (Tax-mapped to Schedule E)
// ============================================================================

export const CHART_OF_ACCOUNTS: Record<string, { name: string; type: 'revenue' | 'expense'; scheduleELine: string }> = {
  '4100': { name: 'Rental Income', type: 'revenue', scheduleELine: 'Line 3' },
  '4200': { name: 'Cleaning Fees Collected', type: 'revenue', scheduleELine: 'Line 3' },
  '5100': { name: 'Cleaning Expense', type: 'expense', scheduleELine: 'Line 9' },
  '5200': { name: 'Repairs & Maintenance', type: 'expense', scheduleELine: 'Line 14' },
  '5300': { name: 'Utilities', type: 'expense', scheduleELine: 'Line 17' },
  '5400': { name: 'Insurance', type: 'expense', scheduleELine: 'Line 9' },
  '5500': { name: 'Management Fees', type: 'expense', scheduleELine: 'Line 11' },
  '6100': { name: 'Mortgage Interest', type: 'expense', scheduleELine: 'Line 12' },
  '6200': { name: 'Property Tax', type: 'expense', scheduleELine: 'Line 16' },
  '6800': { name: 'Depreciation', type: 'expense', scheduleELine: 'Line 18' },
}

// ============================================================================
// Analysis Request/Response
// ============================================================================

export type QueryType =
  | 'property_noi'
  | 'tax_projection'
  | 'qbi_analysis'
  | 'expense_classify'
  | 'portfolio_report'
  | 'entity_recommendation'

export interface AnalysisRequest {
  query_type: QueryType
  params: Record<string, unknown>
  natural_language_query?: string // optional free-text query for Claude reasoning
}

export interface AnalysisResponse {
  query_type: QueryType
  credits_used: number
  data: unknown
  narrative?: string // Claude-generated explanation
  timestamp: string
}

export const SERVICE_CATALOG: Record<QueryType, { credits: number; description: string }> = {
  property_noi: { credits: 2, description: 'Net Operating Income analysis for a single property' },
  tax_projection: { credits: 3, description: 'Federal tax estimate with bracket math and effective rate' },
  qbi_analysis: { credits: 5, description: 'QBI deduction eligibility and phase-out calculation' },
  expense_classify: { credits: 1, description: 'Classify an expense into tax-mapped account category' },
  portfolio_report: { credits: 5, description: 'Full portfolio financial health across all entities' },
  entity_recommendation: { credits: 3, description: 'Schedule E vs S-Corp entity structure analysis' },
}
