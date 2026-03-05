// Agent Handler — Routes incoming requests to analysis functions

import type { AnalysisRequest, AnalysisResponse, QueryType } from '../types.js'
import { SERVICE_CATALOG } from '../types.js'
import {
  analyzePropertyNOI,
  analyzeTaxProjection,
  analyzeQBI,
  classifyExpense,
  generatePortfolioReport,
  recommendEntityStructure,
} from '../finance/analysis.js'
import { generateNarrative } from './reasoning.js'
import { rtdb } from '../firebase/config.js'

export function getCreditsForQuery(queryType: QueryType): number {
  return SERVICE_CATALOG[queryType]?.credits ?? 1
}

export async function handleAnalysisRequest(request: AnalysisRequest): Promise<AnalysisResponse> {
  const { query_type, params } = request
  const credits = getCreditsForQuery(query_type)

  let data: unknown

  switch (query_type) {
    case 'property_noi': {
      const propertyId = params.property_id as string
      if (!propertyId) throw new Error('property_id is required')
      data = await analyzePropertyNOI(propertyId)
      break
    }

    case 'tax_projection': {
      const ownerId = (params.owner_id as string) || 'owner-01'
      data = await analyzeTaxProjection(ownerId)
      break
    }

    case 'qbi_analysis': {
      const ownerId = (params.owner_id as string) || 'owner-01'
      data = await analyzeQBI(ownerId)
      break
    }

    case 'expense_classify': {
      const description = params.description as string
      const amount = params.amount as number
      if (!description) throw new Error('description is required')
      data = classifyExpense(description, amount ?? 0)
      break
    }

    case 'portfolio_report': {
      const ownerId = (params.owner_id as string) || 'owner-01'
      data = await generatePortfolioReport(ownerId)
      break
    }

    case 'entity_recommendation': {
      const ownerId = (params.owner_id as string) || 'owner-01'
      data = await recommendEntityStructure(ownerId)
      break
    }

    default:
      throw new Error(`Unknown query_type: ${query_type}`)
  }

  // Generate narrative if requested or for complex queries
  let narrative: string | undefined
  if (request.natural_language_query || ['portfolio_report', 'qbi_analysis', 'entity_recommendation'].includes(query_type)) {
    try {
      narrative = await generateNarrative(query_type, data, request.natural_language_query)
    } catch (err) {
      // Don't fail the whole request if narrative generation fails
      console.error('Narrative generation failed:', err)
    }
  }

  // Update stats
  try {
    const statsRef = rtdb.ref('/stats')
    const snap = await statsRef.get()
    const stats = snap.val() || { totalQueries: 0, totalCreditsEarned: 0, queriesByType: {} }
    stats.totalQueries += 1
    stats.totalCreditsEarned += credits
    stats.queriesByType[query_type] = (stats.queriesByType[query_type] || 0) + 1
    await statsRef.set(stats)
  } catch {
    // non-critical
  }

  return {
    query_type,
    credits_used: credits,
    data,
    narrative,
    timestamp: new Date().toISOString(),
  }
}
