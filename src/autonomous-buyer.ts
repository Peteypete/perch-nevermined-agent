import 'dotenv/config'
import { Payments } from '@nevermined-io/payments'
import { discoverAgents } from './buyer/discovery.js'
import { scoreAgent, shouldPurchase } from './buyer/evaluator.js'
import { executePurchase, buildQuery } from './buyer/purchaser.js'
import { BudgetManager } from './buyer/budget.js'
import { createBuyerRouter } from './buyer/routes.js'
import type { DiscoveredAgent, AgentScore } from './buyer/types.js'
import { getAllSubmitted, toDiscoveredAgent } from './connect/routes.js'

// ============================================================================
// Init
// ============================================================================

const payments = Payments.getInstance({
  nvmApiKey: process.env.BUYER_API_KEY!,
  environment: 'sandbox'
})

const budget = new BudgetManager(50)
let discoveredAgents: DiscoveredAgent[] = []
let agentScores: Map<string, AgentScore> = new Map()
let isRunning = false
let lastDiscovery = ''
let lastPurchase = ''
let cycleCount = 0

// ============================================================================
// Autonomous Loop
// ============================================================================

async function runAutonomousCycle() {
  if (isRunning) return
  isRunning = true
  cycleCount++

  console.log(`\n${'='.repeat(60)}`)
  console.log(`[Cycle ${cycleCount}] Starting autonomous buy cycle...`)
  console.log(`[Cycle ${cycleCount}] Budget: ${budget.remaining}/${budget.getStatus().totalBudget} credits remaining`)
  console.log(`${'='.repeat(60)}`)

  try {
    // Phase 1: Discover agents
    console.log('\n--- Phase 1: Discovery ---')
    discoveredAgents = await discoverAgents(payments)
    lastDiscovery = new Date().toISOString()

    // Inject community-submitted agents
    const submitted = getAllSubmitted()
    for (const sa of submitted) {
      const da = toDiscoveredAgent(sa)
      if (!discoveredAgents.find(a => a.agentId === da.agentId)) {
        discoveredAgents.push(da)
        console.log(`[Discovery] + Community agent: ${da.name}`)
      }
    }

    if (discoveredAgents.length === 0) {
      console.log('[Cycle] No agents found. Will retry next cycle.')
      isRunning = false
      return
    }

    // Phase 2: Score and rank agents
    console.log('\n--- Phase 2: Scoring ---')
    agentScores = new Map()
    const purchases = budget.getPurchases()

    for (const agent of discoveredAgents) {
      const score = scoreAgent(agent, purchases)
      agentScores.set(agent.agentId, score)
      console.log(`  ${agent.name}: overall=${score.overallScore} (rel=${score.relevanceScore} cost=${score.costScore} qual=${score.qualityScore})`)
    }

    // Sort by overall score, with new agents boosted to top
    const ranked = [...discoveredAgents].sort((a, b) => {
      const aScore = agentScores.get(a.agentId)?.overallScore || 0
      const bScore = agentScores.get(b.agentId)?.overallScore || 0
      // Boost new agents by 20 points
      const aBoost = budget.getPurchasesForAgent(a.agentId).length === 0 ? 20 : 0
      const bBoost = budget.getPurchasesForAgent(b.agentId).length === 0 ? 20 : 0
      return (bScore + bBoost) - (aScore + aBoost)
    })

    // Phase 3: Purchase from top-ranked agents
    console.log('\n--- Phase 3: Purchasing ---')
    const status = budget.getStatus()
    const uniqueAgentsBought = new Set(status.uniqueAgentIds)

    for (const agent of ranked) {
      if (!budget.canAfford(1)) {
        console.log('[Cycle] Budget exhausted.')
        break
      }

      const score = agentScores.get(agent.agentId)
      if (!score) continue

      if (!shouldPurchase(agent, score, uniqueAgentsBought, status.totalTransactions)) {
        console.log(`[Cycle] Skipping ${agent.name} (low ROI)`)
        continue
      }

      // Build and execute purchase
      const query = buildQuery(agent)
      const record = await executePurchase(payments, agent, query)
      budget.recordPurchase(record)

      if (record.success) {
        uniqueAgentsBought.add(agent.agentId)
        lastPurchase = new Date().toISOString()
      }
    }

    // Summary
    const finalStatus = budget.getStatus()
    console.log(`\n--- Cycle ${cycleCount} Complete ---`)
    console.log(`  Transactions: ${finalStatus.totalTransactions}`)
    console.log(`  Unique agents: ${finalStatus.uniqueAgents}`)
    console.log(`  Credits spent: ${finalStatus.spent}`)
    console.log(`  Credits remaining: ${finalStatus.remaining}`)

  } catch (err: any) {
    console.error(`[Cycle] Error: ${err.message}`)
  }

  isRunning = false
}

// ============================================================================
// Exported Router + Loop Starter
// ============================================================================

export const buyerRouter = createBuyerRouter({
  budget,
  getDiscoveredAgents: () => discoveredAgents,
  getAgentScores: () => agentScores,
  getIsRunning: () => isRunning,
  getLastDiscovery: () => lastDiscovery,
  getLastPurchase: () => lastPurchase,
  getCycleCount: () => cycleCount,
  triggerDiscover: async () => {
    discoveredAgents = await discoverAgents(payments)
    lastDiscovery = new Date().toISOString()

    agentScores = new Map()
    const purchases = budget.getPurchases()
    for (const agent of discoveredAgents) {
      agentScores.set(agent.agentId, scoreAgent(agent, purchases))
    }

    return {
      discovered: discoveredAgents.length,
      agents: discoveredAgents.map(a => ({
        name: a.name,
        agentId: a.agentId.slice(0, 16) + '...',
        planId: a.planId.slice(0, 16) + '...',
        endpoint: a.endpoint,
        services: a.serviceCatalog.length,
        score: agentScores.get(a.agentId)?.overallScore || 0,
      })),
    }
  },
  triggerBuyCycle: async () => {
    const beforeCount = budget.getStatus().totalTransactions
    await runAutonomousCycle()
    const afterCount = budget.getStatus().totalTransactions
    return {
      newPurchases: afterCount - beforeCount,
      status: budget.getStatus(),
    }
  },
})

export async function purchaseFromSubmitted(
  agent: DiscoveredAgent,
): Promise<{ success: boolean; responseTimeMs: number; satisfactionScore: number; error?: string }> {
  // Add to discovered pool
  if (!discoveredAgents.find(a => a.agentId === agent.agentId)) {
    discoveredAgents.push(agent)
  }

  console.log(`[Connect] Auto-purchasing from ${agent.name}...`)

  if (!budget.canAfford(1)) {
    return { success: false, responseTimeMs: 0, satisfactionScore: 0, error: 'Budget exhausted' }
  }

  const query = buildQuery(agent)
  const record = await executePurchase(payments, agent, query)
  budget.recordPurchase(record)

  if (record.success) {
    lastPurchase = new Date().toISOString()
  }

  return {
    success: record.success,
    responseTimeMs: record.responseTimeMs,
    satisfactionScore: record.satisfactionScore,
    error: record.error,
  }
}

export function startBuyerLoop() {
  console.log(`\nPerch Autonomous Buyer Agent`)
  console.log(`============================`)
  console.log(`Budget: ${budget.getStatus().totalBudget} credits`)
  console.log(`Routes: /api/buyer/* (mounted on seller)\n`)

  // Run first cycle immediately
  console.log('Starting initial discovery + purchase cycle...\n')
  runAutonomousCycle()

  // Then repeat every 5 minutes
  setInterval(runAutonomousCycle, 5 * 60 * 1000)
}
