// Autonomous Buyer — ROI Evaluator

import type { DiscoveredAgent, PurchaseRecord, AgentScore } from './types.js'

// Keywords that indicate relevance to our domain (tax, finance, real estate)
const RELEVANCE_KEYWORDS = [
  'tax', 'finance', 'real estate', 'property', 'investment', 'accounting',
  'data', 'ai', 'analysis', 'report', 'portfolio', 'income', 'expense',
  'str', 'rental', 'noi', 'qbi', 'depreciation', 'insurance',
  'market', 'pricing', 'weather', 'travel', 'booking', 'hospitality',
]

export function scoreAgent(agent: DiscoveredAgent, pastPurchases: PurchaseRecord[]): AgentScore {
  const relevanceScore = computeRelevance(agent)
  const costScore = computeCostEfficiency(agent)
  const qualityScore = computeQuality(agent.agentId, pastPurchases)

  const overallScore = relevanceScore * 0.3 + costScore * 0.3 + qualityScore * 0.4
  const agentPurchases = pastPurchases.filter(p => p.agentId === agent.agentId)

  return {
    agentId: agent.agentId,
    relevanceScore: Math.round(relevanceScore),
    costScore: Math.round(costScore),
    qualityScore: Math.round(qualityScore),
    overallScore: Math.round(overallScore),
    purchaseCount: agentPurchases.length,
    avgSatisfaction: agentPurchases.length
      ? Math.round(agentPurchases.reduce((s, p) => s + p.satisfactionScore, 0) / agentPurchases.length)
      : 0,
  }
}

function computeRelevance(agent: DiscoveredAgent): number {
  const text = [
    agent.name,
    agent.description,
    ...agent.tags,
    ...agent.serviceCatalog.map(s => s.description),
  ].join(' ').toLowerCase()

  if (!text.trim()) return 30 // give unknown agents a base score

  let matches = 0
  for (const keyword of RELEVANCE_KEYWORDS) {
    if (text.includes(keyword)) matches++
  }

  return Math.min(100, (matches / RELEVANCE_KEYWORDS.length) * 200 + 20)
}

function computeCostEfficiency(agent: DiscoveredAgent): number {
  // Free plans are great, expensive ones less so
  const avgCost = agent.serviceCatalog.length
    ? agent.serviceCatalog.reduce((s, svc) => s + svc.credits, 0) / agent.serviceCatalog.length
    : 1

  if (avgCost <= 1) return 100
  if (avgCost <= 3) return 80
  if (avgCost <= 5) return 60
  if (avgCost <= 10) return 40
  return 20
}

function computeQuality(agentId: string, pastPurchases: PurchaseRecord[]): number {
  const agentPurchases = pastPurchases.filter(p => p.agentId === agentId && p.success)
  if (agentPurchases.length === 0) return 50 // neutral default for new agents

  return agentPurchases.reduce((s, p) => s + p.satisfactionScore, 0) / agentPurchases.length
}

export function shouldPurchase(
  agent: DiscoveredAgent,
  score: AgentScore,
  uniqueAgentsBought: Set<string>,
  totalTransactions: number,
): boolean {
  // Priority 1: Always buy from new agents for diversity (hackathon criteria: 2+ teams)
  if (!uniqueAgentsBought.has(agent.agentId) && uniqueAgentsBought.size < 5) {
    return true
  }

  // Priority 2: Need 3+ transactions minimum
  if (totalTransactions < 3) {
    return true
  }

  // Priority 3: Repeat purchase if satisfaction is good
  if (score.avgSatisfaction > 60 || score.overallScore > 50) {
    return true
  }

  return false
}

export function scoreResponse(response: any, status: number): number {
  let score = 0

  // Successful response
  if (status >= 200 && status < 300) score += 40
  else return 10 // failed response

  // Has data
  const body = typeof response === 'string' ? response : JSON.stringify(response)
  if (body.length > 100) score += 20
  if (body.length > 500) score += 10

  // Has structured data
  if (response && typeof response === 'object') {
    if (response.data || response.result || response.results) score += 15
    if (response.narrative || response.explanation || response.summary) score += 15
  }

  return Math.min(100, score)
}
