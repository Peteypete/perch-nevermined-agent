// Connect — Agent Submission & Auto-Buy Routes

import { Router, Request, Response } from 'express'
import type { DiscoveredAgent } from '../buyer/types.js'

// ============================================================================
// Types
// ============================================================================

interface SubmittedService {
  path: string
  credits: number
  description?: string
}

interface AgentSubmission {
  name: string
  planId?: string   // optional for direct submissions
  agentId?: string  // optional for direct submissions
  url: string
  services: SubmittedService[]
  submitterName?: string
  description?: string
  buyType?: 'nevermined' | 'direct'
}

interface SubmittedAgent {
  id: string
  name: string
  planId: string
  agentId: string
  url: string
  services: SubmittedService[]
  submitterName: string
  description: string
  submittedAt: string
  buyType: 'nevermined' | 'direct'
  status: 'pending' | 'purchased' | 'failed'
  purchaseResult?: {
    success: boolean
    responseTimeMs: number
    satisfactionScore: number
    error?: string
  }
}

// ============================================================================
// In-Memory Store
// ============================================================================

const agents = new Map<string, SubmittedAgent>()

export function loadSubmittedAgents(): void {
  // no-op: in-memory only
}

function saveAgent(submission: AgentSubmission): SubmittedAgent {
  const id = `submitted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const url = submission.url.trim().replace(/\/$/, '')
  const buyType = submission.buyType || (submission.planId && submission.agentId ? 'nevermined' : 'direct')
  const agent: SubmittedAgent = {
    id,
    name: submission.name?.trim() || url,
    planId: submission.planId?.trim() || '',
    agentId: submission.agentId?.trim() || url, // use URL as unique key for direct agents
    url,
    services: submission.services,
    submitterName: submission.submitterName?.trim() || 'Anonymous',
    description: submission.description?.trim() || '',
    submittedAt: new Date().toISOString(),
    buyType,
    status: 'pending',
  }
  agents.set(id, agent)
  return agent
}

function updateStatus(
  id: string,
  status: SubmittedAgent['status'],
  purchaseResult?: SubmittedAgent['purchaseResult'],
): void {
  const agent = agents.get(id)
  if (!agent) return
  agent.status = status
  if (purchaseResult) agent.purchaseResult = purchaseResult
}

function isDuplicate(submission: AgentSubmission): boolean {
  const url = submission.url.trim().replace(/\/$/, '')
  const agentId = submission.agentId?.trim()
  return [...agents.values()].some(a =>
    (agentId && a.agentId === agentId) || a.url === url
  )
}

export function getAllSubmitted(): SubmittedAgent[] {
  return [...agents.values()].sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
  )
}

export function toDiscoveredAgent(submitted: SubmittedAgent): DiscoveredAgent {
  return {
    agentId: submitted.agentId,
    planId: submitted.planId,
    name: submitted.name,
    description: submitted.description || `Submitted by ${submitted.submitterName}`,
    tags: ['hackathon', 'community', 'submitted'],
    endpoint: submitted.url,
    creditsPerPlan: 100,
    buyType: submitted.buyType,
    serviceCatalog: submitted.services.map(s => ({
      query_type: s.path.replace(/^\//, ''),
      credits: s.credits,
      description: s.description || s.path,
    })),
  }
}

// ============================================================================
// Auto-Purchase Trigger
// ============================================================================

type PurchaseTrigger = (agent: DiscoveredAgent) => Promise<{ success: boolean; responseTimeMs: number; satisfactionScore: number; error?: string }>

let onNewAgent: PurchaseTrigger | null = null
let onTestBuy: PurchaseTrigger | null = null

export function setPurchaseTrigger(trigger: PurchaseTrigger) {
  onNewAgent = trigger
  onTestBuy = trigger
}

// ============================================================================
// Routes
// ============================================================================

export function createConnectRouter(): Router {
  const router = Router()

  // POST /submit — submit a new agent
  router.post('/submit', async (req: Request, res: Response) => {
    const body = req.body as AgentSubmission

    // Validate
    const errors: string[] = []
    if (!body.url?.trim()) errors.push('url is required')
    if (!Array.isArray(body.services) || body.services.length === 0) {
      errors.push('at least one service is required')
    }
    // Nevermined agents need planId + agentId
    const isNevermined = body.buyType === 'nevermined' || (body.planId && body.agentId)
    if (isNevermined) {
      if (!body.planId?.trim()) errors.push('planId is required for Nevermined agents')
      if (!body.agentId?.trim()) errors.push('agentId is required for Nevermined agents')
    }

    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', details: errors })
      return
    }

    if (isDuplicate(body)) {
      res.status(409).json({
        error: 'Agent already submitted',
        message: 'This agent is already connected. Tallyfor AI will continue buying from it.',
      })
      return
    }

    const agent = await saveAgent(body)

    // Trigger auto-purchase in background
    if (onNewAgent) {
      const discovered = toDiscoveredAgent(agent)
      onNewAgent(discovered)
        .then(result => updateStatus(agent.id, result.success ? 'purchased' : 'failed', result))
        .catch(err => updateStatus(agent.id, 'failed', {
          success: false, responseTimeMs: 0, satisfactionScore: 0, error: err.message,
        }))
    }

    res.status(201).json({
      message: `Welcome ${agent.name}! Tallyfor AI will start buying from you shortly.`,
      agent,
      autoPurchase: !!onNewAgent,
    })
  })

  // POST /test-buy — test buy from an agent without submitting it
  router.post('/test-buy', async (req: Request, res: Response) => {
    const { buyType, planId, agentId, url, name } = req.body

    if (!onTestBuy) {
      res.status(503).json({ error: 'Buyer not available — set BUYER_API_KEY to enable' })
      return
    }

    if (buyType === 'nevermined') {
      if (!planId?.trim() || !agentId?.trim()) {
        res.status(400).json({ error: 'planId and agentId are required for Nevermined test buy' })
        return
      }
    } else {
      if (!url?.trim()) {
        res.status(400).json({ error: 'url is required for Direct test buy' })
        return
      }
    }

    const agent: DiscoveredAgent = {
      agentId: agentId?.trim() || url?.trim(),
      planId: planId?.trim() || '',
      name: name?.trim() || (buyType === 'direct' ? 'Direct Agent' : 'Nevermined Agent'),
      description: '',
      tags: ['test'],
      endpoint: url?.trim() || '',
      creditsPerPlan: 100,
      buyType: buyType === 'direct' ? 'direct' : 'nevermined',
      serviceCatalog: [],
    }

    try {
      const result = await onTestBuy(agent)
      res.json({ success: result.success, responseTimeMs: result.responseTimeMs, satisfactionScore: result.satisfactionScore, error: result.error })
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // GET /submitted — list all submitted agents
  router.get('/submitted', (_req: Request, res: Response) => {
    const all = getAllSubmitted()
    res.json({
      total: all.length,
      purchased: all.filter(a => a.status === 'purchased').length,
      pending: all.filter(a => a.status === 'pending').length,
      failed: all.filter(a => a.status === 'failed').length,
      agents: all,
    })
  })

  return router
}
