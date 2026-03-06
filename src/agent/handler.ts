// Agent Handler — Routes incoming requests to analysis functions

import type { AnalysisRequest, AnalysisResponse, QueryType, PriorYearReturn } from '../types.js'
import { SERVICE_CATALOG } from '../types.js'
import {
  analyzePropertyNOI,
  analyzeTaxProjection,
  analyzeQBI,
  classifyExpense,
  generatePortfolioReport,
  recommendEntityStructure,
  analyze1031Exchange,
  analyzeStateRelocation,
  analyzeInternational,
  analyzeTransferPricing,
  analyzeSalesTaxNexus,
  analyzeBusinessReturn,
  analyzePersonalReturnOptimization,
  analyzePersonalReturnFiling,
} from '../finance/analysis.js'
import { generateNarrative } from './reasoning.js'
import { recordQuery } from '../data/store.js'

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
      const priorYearReturn = params.prior_year_return as PriorYearReturn | undefined
      data = await analyzeTaxProjection(ownerId, priorYearReturn)
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

    case 'exchange_1031': {
      data = await analyze1031Exchange(params)
      break
    }

    case 'state_relocation': {
      data = await analyzeStateRelocation(params)
      break
    }

    case 'international_analysis': {
      data = await analyzeInternational(params)
      break
    }

    case 'transfer_pricing': {
      data = await analyzeTransferPricing(params)
      break
    }

    case 'sales_tax_nexus': {
      data = await analyzeSalesTaxNexus(params)
      break
    }

    case 'business_return': {
      data = await analyzeBusinessReturn(params)
      break
    }

    case 'personal_return_optimization': {
      data = await analyzePersonalReturnOptimization(params)
      break
    }

    case 'personal_return_filing': {
      data = await analyzePersonalReturnFiling(params)
      break
    }

    default:
      throw new Error(`Unknown query_type: ${query_type}`)
  }

  // Generate narrative if requested or for complex queries
  let narrative: string | undefined
  if (request.natural_language_query || ['tax_projection', 'portfolio_report', 'qbi_analysis', 'entity_recommendation', 'exchange_1031', 'state_relocation', 'international_analysis', 'transfer_pricing', 'sales_tax_nexus', 'business_return', 'personal_return_optimization', 'personal_return_filing'].includes(query_type)) {
    try {
      narrative = await generateNarrative(query_type, data, request.natural_language_query)
    } catch (err) {
      // Don't fail the whole request if narrative generation fails
      console.error('Narrative generation failed:', err)
    }
  }

  // Update stats
  recordQuery(query_type, credits)

  return {
    query_type,
    credits_used: credits,
    data,
    narrative,
    timestamp: new Date().toISOString(),
  }
}
