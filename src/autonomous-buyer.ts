import 'dotenv/config'
import express, { Request, Response } from 'express'
import cors from 'cors'
import { Payments } from '@nevermined-io/payments'
import { discoverAgents } from './buyer/discovery.js'
import { scoreAgent, shouldPurchase } from './buyer/evaluator.js'
import { executePurchase, buildQuery } from './buyer/purchaser.js'
import { BudgetManager } from './buyer/budget.js'
import type { DiscoveredAgent, PurchaseRecord, AgentScore } from './buyer/types.js'

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
// Express API
// ============================================================================

const app = express()
app.use(express.json())
app.use(cors())

// Status overview
app.get('/api/buyer/status', (_req: Request, res: Response) => {
  const status = budget.getStatus()
  res.json({
    ...status,
    isRunning,
    lastDiscovery,
    lastPurchase,
    cycleCount,
    discoveredAgentCount: discoveredAgents.length,
    criteria: {
      minTransactions: 3,
      minUniqueAgents: 2,
      transactionsMet: status.totalTransactions >= 3,
      uniqueAgentsMet: status.uniqueAgents >= 2,
    },
  })
})

// Purchase history
app.get('/api/buyer/purchases', (_req: Request, res: Response) => {
  res.json({
    purchases: budget.getPurchases(),
    total: budget.getStatus().totalTransactions,
  })
})

// Discovered agents with scores
app.get('/api/buyer/agents', (_req: Request, res: Response) => {
  const agentsWithScores = discoveredAgents.map(a => ({
    ...a,
    score: agentScores.get(a.agentId) || null,
    purchaseHistory: budget.getPurchasesForAgent(a.agentId),
  }))
  res.json({ agents: agentsWithScores, total: agentsWithScores.length })
})

// Trigger manual discovery
app.post('/api/buyer/discover', async (_req: Request, res: Response) => {
  if (isRunning) {
    res.json({ message: 'Cycle already running' })
    return
  }
  // Run discovery only (no purchasing)
  discoveredAgents = await discoverAgents(payments)
  lastDiscovery = new Date().toISOString()

  agentScores = new Map()
  const purchases = budget.getPurchases()
  for (const agent of discoveredAgents) {
    agentScores.set(agent.agentId, scoreAgent(agent, purchases))
  }

  res.json({
    discovered: discoveredAgents.length,
    agents: discoveredAgents.map(a => ({
      name: a.name,
      agentId: a.agentId.slice(0, 16) + '...',
      planId: a.planId.slice(0, 16) + '...',
      endpoint: a.endpoint,
      services: a.serviceCatalog.length,
      score: agentScores.get(a.agentId)?.overallScore || 0,
    })),
  })
})

// Trigger manual purchase cycle
app.post('/api/buyer/buy', async (_req: Request, res: Response) => {
  if (isRunning) {
    res.json({ message: 'Cycle already running' })
    return
  }

  const beforeCount = budget.getStatus().totalTransactions
  await runAutonomousCycle()
  const afterCount = budget.getStatus().totalTransactions

  res.json({
    newPurchases: afterCount - beforeCount,
    status: budget.getStatus(),
  })
})

// ============================================================================
// Start
// ============================================================================

const PORT = process.env.BUYER_PORT || 3001
app.listen(PORT, () => {
  console.log(`\nPerch Autonomous Buyer Agent`)
  console.log(`============================`)
  console.log(`Server:   http://localhost:${PORT}`)
  console.log(`Budget:   ${budget.getStatus().totalBudget} credits`)
  console.log(`\nEndpoints:`)
  console.log(`  GET  /api/buyer/status     — budget & progress`)
  console.log(`  GET  /api/buyer/purchases  — purchase history`)
  console.log(`  GET  /api/buyer/agents     — discovered agents`)
  console.log(`  POST /api/buyer/discover   — manual scan`)
  console.log(`  POST /api/buyer/buy        — manual purchase cycle`)
  console.log()

  // Run first cycle immediately
  console.log('Starting initial discovery + purchase cycle...\n')
  runAutonomousCycle()

  // Then repeat every 5 minutes
  setInterval(runAutonomousCycle, 5 * 60 * 1000)
})
