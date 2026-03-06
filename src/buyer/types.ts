// Autonomous Buyer — Types

export interface DiscoveredAgent {
  agentId: string
  planId: string
  name: string
  description: string
  tags: string[]
  endpoint: string          // URL to call for queries
  creditsPerPlan: number    // credits granted when ordering plan
  serviceCatalog: ServiceInfo[]
  buyType: 'nevermined' | 'direct'  // nevermined = x402 token flow, direct = POST straight to URL
  customBody?: Record<string, unknown> // custom request body for direct agents
}

export interface ServiceInfo {
  query_type: string
  credits: number
  description: string
}

export interface PurchaseRecord {
  id: string
  timestamp: string
  agentId: string
  agentName: string
  planId: string
  queryType: string
  creditsCost: number
  responseStatus: number
  responseTimeMs: number
  satisfactionScore: number   // 0-100
  responsePreview: string     // first 200 chars of response
  success: boolean
  error?: string
}

export interface BudgetState {
  totalBudget: number
  spent: number
  remaining: number
  totalTransactions: number
  uniqueAgents: Set<string>
  purchases: PurchaseRecord[]
}

export interface AgentScore {
  agentId: string
  relevanceScore: number    // 0-100
  costScore: number         // 0-100
  qualityScore: number      // 0-100
  overallScore: number      // weighted composite
  purchaseCount: number
  avgSatisfaction: number
}
