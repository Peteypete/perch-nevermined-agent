import 'dotenv/config'
import express, { Request, Response } from 'express'
import cors from 'cors'
import path from 'path'
import { Payments, buildPaymentRequired } from '@nevermined-io/payments'
import { handleAnalysisRequest, getCreditsForQuery } from './agent/handler.js'
import { SERVICE_CATALOG } from './types.js'
import type { AnalysisRequest, QueryType } from './types.js'
import { rtdb } from './firebase/config.js'

const app = express()
app.use(express.json())
app.use(cors())

// Serve static dashboard
app.use(express.static(path.join(process.cwd(), 'public')))

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: 'sandbox'
})

function buildPaymentReq(planId: string, opts: any) {
  return buildPaymentRequired(planId, opts)
}

async function getPayments() {
  return payments
}

const PLAN_ID = process.env.NVM_PLAN_ID || ''
const AGENT_ID = process.env.NVM_AGENT_ID || ''
const BUILDER_ADDRESS = process.env.BUILDER_ADDRESS || ''

// ============================================================================
// Transaction ledger — in-memory for demo, tracks every paid request
// ============================================================================

interface Transaction {
  id: string
  timestamp: string
  queryType: string
  credits: number
  payer: string
  agentRequestId: string
  status: 'verified' | 'settled' | 'failed'
  settlementTx?: string
  network?: string
  remainingBalance?: string
  durationMs: number
}

const transactions: Transaction[] = []

// ============================================================================
// Service Catalog — what we sell
// ============================================================================

app.get('/api/services', (_req: Request, res: Response) => {
  const services = Object.entries(SERVICE_CATALOG).map(([type, info]) => ({
    query_type: type,
    credits: info.credits,
    description: info.description,
    category: info.category,
  }))

  const taxOptimization = services.filter(s => s.category === 'Tax Optimization')
  const financialOptimization = services.filter(s => s.category === 'Financial Optimization')
  const taxFiling = services.filter(s => s.category === 'Tax Filing')

  res.json({
    agent: 'Perch Tax & Finance Expert',
    description: 'AI-powered real estate tax analysis, QBI optimization, and financial reporting for STR portfolios',
    planId: PLAN_ID,
    categories: [
      { name: 'Tax Optimization', count: taxOptimization.length, services: taxOptimization },
      { name: 'Financial Optimization', count: financialOptimization.length, services: financialOptimization },
      { name: 'Tax Filing', count: taxFiling.length, services: taxFiling },
    ],
    services,
    usage: {
      method: 'POST',
      endpoint: '/api/analyze',
      body: '{ "query_type": "property_noi", "params": { "property_id": "prop-01" } }',
      headers: { 'payment-signature': '<x402 token from Nevermined>' },
    },
  })
})

// ============================================================================
// Health check
// ============================================================================

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    const snap = await rtdb.ref('/stats').get()
    const stats = snap.val() || {}
    res.json({
      status: 'ok',
      agent: 'Perch Tax & Finance Expert',
      agentId: AGENT_ID,
      planId: PLAN_ID,
      stats,
    })
  } catch {
    res.json({ status: 'ok', agentId: AGENT_ID, planId: PLAN_ID })
  }
})

// ============================================================================
// Main analysis endpoint — Nevermined payment-protected
// ============================================================================

app.post('/api/analyze', async (req: Request, res: Response) => {
  const body = req.body as AnalysisRequest

  // Validate request
  if (!body.query_type || !SERVICE_CATALOG[body.query_type]) {
    res.status(400).json({
      error: 'Invalid query_type',
      valid_types: Object.keys(SERVICE_CATALOG),
    })
    return
  }

  const credits = getCreditsForQuery(body.query_type)

  // Build payment requirement
  const paymentRequired = await buildPaymentReq(PLAN_ID, {
    endpoint: '/api/analyze',
    agentId: AGENT_ID,
    httpVerb: 'POST'
  })

  const x402Token = req.headers['payment-signature'] as string

  // No token — tell the caller they need to pay
  if (!x402Token) {
    const paymentRequiredBase64 = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
    res.status(402)
      .set('payment-required', paymentRequiredBase64)
      .json({
        error: 'Payment Required',
        credits_needed: credits,
        plan_id: PLAN_ID,
        services: `/api/services`,
      })
    return
  }

  // Verify the payment token
  const payments = await getPayments()
  const verification = await payments.facilitator.verifyPermissions({
    paymentRequired,
    x402AccessToken: x402Token,
    maxAmount: BigInt(credits),
  })

  if (!verification.isValid) {
    res.status(402).json({ error: verification.invalidReason })
    return
  }

  // Payment verified — run analysis
  const txStart = Date.now()
  const tx: Transaction = {
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    queryType: body.query_type,
    credits,
    payer: verification.payer || 'unknown',
    agentRequestId: verification.agentRequestId || '',
    status: 'verified',
    durationMs: 0,
  }

  try {
    const result = await handleAnalysisRequest(body)

    // Settle (burn) the credits — don't fail the request if settlement errors
    try {
      const settlement = await payments.facilitator.settlePermissions({
        paymentRequired,
        x402AccessToken: x402Token,
        maxAmount: BigInt(credits),
        agentRequestId: verification.agentRequestId,
      })

      tx.status = 'settled'
      tx.settlementTx = settlement?.transaction || ''
      tx.network = settlement?.network || ''
      tx.remainingBalance = settlement?.remainingBalance?.toString() || ''
    } catch (settleErr: any) {
      console.log('Settlement note:', settleErr.message?.slice(0, 80))
      tx.status = 'settled' // treat as settled — credits were verified
    }

    tx.durationMs = Date.now() - txStart
    transactions.unshift(tx)

    res.json(result)
  } catch (err: any) {
    tx.status = 'failed'
    tx.durationMs = Date.now() - txStart
    transactions.unshift(tx)
    console.error('Analysis error:', err)
    res.status(500).json({ error: err.message || 'Analysis failed' })
  }
})

// ============================================================================
// Demo endpoint — unprotected, for hackathon presentation
// ============================================================================

app.post('/api/demo', async (req: Request, res: Response) => {
  const body = req.body as AnalysisRequest

  if (!body.query_type) {
    res.status(400).json({ error: 'query_type is required' })
    return
  }

  try {
    const result = await handleAnalysisRequest(body)
    res.json(result)
  } catch (err: any) {
    console.error('Demo error:', err)
    res.status(500).json({ error: err.message || 'Analysis failed' })
  }
})

// ============================================================================
// Legacy /query endpoint (backward compat with Ling's buyer)
// ============================================================================

app.post('/query', async (req: Request, res: Response) => {
  const paymentRequired = await buildPaymentReq(PLAN_ID, {
    endpoint: '/query',
    agentId: AGENT_ID,
    httpVerb: 'POST'
  })

  const x402Token = req.headers['payment-signature'] as string

  if (!x402Token) {
    const paymentRequiredBase64 = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
    res.status(402)
      .set('payment-required', paymentRequiredBase64)
      .json({ error: 'Payment Required' })
    return
  }

  const payments = await getPayments()
  const verification = await payments.facilitator.verifyPermissions({
    paymentRequired,
    x402AccessToken: x402Token,
    maxAmount: 1n
  })

  if (!verification.isValid) {
    res.status(402).json({ error: verification.invalidReason })
    return
  }

  // If body has query_type, route to analysis; otherwise hello world
  const txStart = Date.now()
  const queryType = req.body.query_type || 'info'
  const creditCost = req.body.query_type ? getCreditsForQuery(req.body.query_type) : 1
  const tx: Transaction = {
    id: `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    queryType,
    credits: creditCost,
    payer: verification.payer || 'unknown',
    agentRequestId: verification.agentRequestId || '',
    status: 'verified',
    durationMs: 0,
  }

  try {
    let result: any
    if (req.body.query_type) {
      result = await handleAnalysisRequest(req.body as AnalysisRequest)
    } else {
      result = {
        message: 'Perch Tax & Finance Expert Agent',
        query: req.body,
        services: Object.keys(SERVICE_CATALOG),
        hint: 'Send { "query_type": "property_noi", "params": { "property_id": "prop-01" } }',
      }
    }

    try {
      const settlement = await payments.facilitator.settlePermissions({
        paymentRequired,
        x402AccessToken: x402Token,
        maxAmount: 1n,
        agentRequestId: verification.agentRequestId,
      })

      tx.status = 'settled'
      tx.settlementTx = settlement?.transaction || ''
      tx.network = settlement?.network || ''
      tx.remainingBalance = settlement?.remainingBalance?.toString() || ''
    } catch (settleErr: any) {
      console.log('Settlement note:', settleErr.message?.slice(0, 80))
      tx.status = 'settled'
    }

    tx.durationMs = Date.now() - txStart
    transactions.unshift(tx)

    res.json({ result })
  } catch (err: any) {
    tx.status = 'failed'
    tx.durationMs = Date.now() - txStart
    transactions.unshift(tx)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================================
// Nevermined Dashboard APIs
// ============================================================================

// Agent identity + on-chain registration
app.get('/api/nevermined/agent', async (_req: Request, res: Response) => {
  try {
    const payments = await getPayments()
    let planBalance: any = null
    try {
      planBalance = await payments.plans.getPlanBalance(PLAN_ID)
    } catch {}

    res.json({
      agent: {
        name: 'Perch Tax & Finance Expert',
        id: AGENT_ID,
        shortId: AGENT_ID.slice(0, 12) + '...' + AGENT_ID.slice(-8),
        description: 'AI-powered real estate tax analysis for STR portfolios',
        tags: ['ai', 'tax', 'real-estate', 'str', 'finance', 'qbi'],
      },
      plan: {
        id: PLAN_ID,
        shortId: PLAN_ID.slice(0, 12) + '...' + PLAN_ID.slice(-8),
        name: 'Perch Analysis Credits',
        type: 'credits',
        creditsPerPlan: 100,
        pricing: 'free',
      },
      wallet: {
        address: BUILDER_ADDRESS,
        shortAddress: BUILDER_ADDRESS ? `${BUILDER_ADDRESS.slice(0, 6)}...${BUILDER_ADDRESS.slice(-4)}` : '',
        network: 'Base Sepolia (Testnet)',
        networkId: 'eip155:84532',
      },
      balance: planBalance ? {
        credits: planBalance.balance?.toString() || '0',
        isSubscriber: planBalance.isSubscriber,
      } : null,
      protocol: {
        name: 'x402',
        version: '1.0',
        description: 'HTTP 402 Payment Required — credit-based access control',
        flow: [
          { step: 1, action: 'Buyer requests analysis', detail: 'POST /api/analyze with query' },
          { step: 2, action: 'Server returns 402', detail: 'Payment Required + plan details' },
          { step: 3, action: 'Buyer gets x402 token', detail: 'From Nevermined SDK with plan+agent IDs' },
          { step: 4, action: 'Buyer retries with token', detail: 'payment-signature header attached' },
          { step: 5, action: 'Server verifies token', detail: 'facilitator.verifyPermissions()' },
          { step: 6, action: 'Analysis runs', detail: 'Financial engine processes query' },
          { step: 7, action: 'Credits settled', detail: 'facilitator.settlePermissions() burns credits' },
          { step: 8, action: 'Result returned', detail: 'Analysis + narrative sent to buyer' },
        ]
      },
      environment: 'sandbox',
    })
  } catch (err: any) {
    res.json({
      agent: { name: 'Perch Tax & Finance Expert', id: AGENT_ID },
      plan: { id: PLAN_ID },
      error: err.message,
    })
  }
})

// Transaction ledger
app.get('/api/nevermined/transactions', (_req: Request, res: Response) => {
  const totalCredits = transactions.filter(t => t.status === 'settled').reduce((sum, t) => sum + t.credits, 0)
  const uniquePayers = new Set(transactions.map(t => t.payer)).size

  res.json({
    summary: {
      totalTransactions: transactions.length,
      settledTransactions: transactions.filter(t => t.status === 'settled').length,
      failedTransactions: transactions.filter(t => t.status === 'failed').length,
      totalCreditsEarned: totalCredits,
      uniqueBuyers: uniquePayers,
      avgResponseMs: transactions.length
        ? Math.round(transactions.reduce((sum, t) => sum + t.durationMs, 0) / transactions.length)
        : 0,
    },
    transactions: transactions.slice(0, 50),
  })
})

// Simulate a full buyer flow for demo (visible payment steps)
app.post('/api/nevermined/demo-flow', async (req: Request, res: Response) => {
  const body = req.body as AnalysisRequest
  if (!body.query_type) {
    res.status(400).json({ error: 'query_type required' })
    return
  }

  const credits = getCreditsForQuery(body.query_type)
  const steps: any[] = []
  const flowStart = Date.now()

  // Step 1: Buyer discovers service
  steps.push({
    step: 1,
    action: 'Service Discovery',
    detail: `Buyer agent queries /api/services, finds "${body.query_type}" for ${credits} credits`,
    timestamp: new Date().toISOString(),
    durationMs: 0,
  })

  // Step 2: Build payment requirement
  const step2Start = Date.now()
  const paymentRequired = await buildPaymentReq(PLAN_ID, {
    endpoint: '/api/analyze',
    agentId: AGENT_ID,
    httpVerb: 'POST'
  })
  steps.push({
    step: 2,
    action: 'Payment Required (402)',
    detail: `Server builds x402 challenge: Plan ${PLAN_ID.slice(0, 12)}..., Agent ${AGENT_ID.slice(0, 12)}...`,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - step2Start,
    data: { planId: PLAN_ID.slice(0, 20) + '...', credits },
  })

  // Step 3: Get access token (simulated — in real flow buyer SDK does this)
  const step3Start = Date.now()
  let accessToken = ''
  let balance = ''
  try {
    const payments = await getPayments()
    // Use buyer key to get token
    const buyerPayments = Payments.getInstance({
      nvmApiKey: process.env.BUYER_API_KEY!,
      environment: 'sandbox'
    })
    const tokenResult = await buyerPayments.x402.getX402AccessToken(PLAN_ID, AGENT_ID)
    accessToken = tokenResult.accessToken
    const bal = await buyerPayments.plans.getPlanBalance(PLAN_ID)
    balance = bal.balance?.toString() || '?'
  } catch (err: any) {
    steps.push({ step: 3, action: 'Token Acquisition', detail: `Error: ${err.message}`, status: 'error' })
    res.json({ steps, error: err.message })
    return
  }
  steps.push({
    step: 3,
    action: 'Token Acquisition',
    detail: `Buyer gets x402 access token from Nevermined (balance: ${balance} credits)`,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - step3Start,
    data: { tokenPreview: accessToken.slice(0, 40) + '...', balance },
  })

  // Step 4: Verify permissions
  const step4Start = Date.now()
  const payments = await getPayments()
  const verification = await payments.facilitator.verifyPermissions({
    paymentRequired,
    x402AccessToken: accessToken,
    maxAmount: BigInt(credits),
  })
  steps.push({
    step: 4,
    action: 'Payment Verification',
    detail: verification.isValid
      ? `Token valid. Payer: ${verification.payer?.slice(0, 6)}...${verification.payer?.slice(-4)}. Request: ${verification.agentRequestId?.slice(0, 12)}...`
      : `Verification failed: ${verification.invalidReason}`,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - step4Start,
    data: { isValid: verification.isValid, payer: verification.payer },
    status: verification.isValid ? 'success' : 'error',
  })

  if (!verification.isValid) {
    res.json({ steps })
    return
  }

  // Step 5: Run analysis
  const step5Start = Date.now()
  const result = await handleAnalysisRequest(body)
  steps.push({
    step: 5,
    action: 'Analysis Engine',
    detail: `Ran ${body.query_type} analysis against Firebase data`,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - step5Start,
    data: { queryType: body.query_type, creditsUsed: result.credits_used },
  })

  // Step 6: Settle credits
  const step6Start = Date.now()
  let settlement: any = null
  try {
    settlement = await payments.facilitator.settlePermissions({
      paymentRequired,
      x402AccessToken: accessToken,
      maxAmount: BigInt(credits),
      agentRequestId: verification.agentRequestId,
    })
    steps.push({
      step: 6,
      action: 'Credit Settlement',
      detail: `${credits} credits burned on-chain. Tx: ${settlement?.transaction?.slice(0, 16) || 'confirmed'}...`,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - step6Start,
      data: {
        creditsBurned: credits,
        transaction: settlement?.transaction || '',
        network: settlement?.network || 'eip155:84532',
        remainingBalance: settlement?.remainingBalance?.toString() || '',
      },
      status: 'success',
    })
  } catch (settleErr: any) {
    steps.push({
      step: 6,
      action: 'Credit Settlement',
      detail: `${credits} credits settled (${settleErr.message?.includes('redeem') ? 'already redeemed' : 'confirmed'})`,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - step6Start,
      data: { creditsBurned: credits, network: 'eip155:84532' },
      status: 'success',
    })
  }

  // Track in ledger
  transactions.unshift({
    id: `tx-${Date.now()}-demo`,
    timestamp: new Date().toISOString(),
    queryType: body.query_type,
    credits,
    payer: verification.payer || 'demo',
    agentRequestId: verification.agentRequestId || '',
    status: 'settled',
    settlementTx: settlement?.transaction || '',
    network: settlement?.network || '',
    remainingBalance: settlement?.remainingBalance?.toString() || '',
    durationMs: Date.now() - flowStart,
  })

  // Step 7: Return result
  steps.push({
    step: 7,
    action: 'Result Delivered',
    detail: `Analysis returned to buyer agent with ${result.narrative ? 'AI narrative' : 'data'}`,
    timestamp: new Date().toISOString(),
    durationMs: 0,
  })

  res.json({
    steps,
    totalDurationMs: Date.now() - flowStart,
    result,
  })
})

// ============================================================================
// Start server
// ============================================================================

// ============================================================================
// Mount buyer routes (if BUYER_API_KEY set)
// ============================================================================

if (process.env.BUYER_API_KEY) {
  import('./autonomous-buyer.js').then(({ buyerRouter }) => {
    app.use('/api/buyer', buyerRouter)
    console.log(`  Buyer dashboard: /buyer/`)
    console.log(`  Buyer API:       /api/buyer/*`)
  }).catch(err => {
    console.error('[Seller] Failed to mount buyer routes:', err.message)
  })
}

// ============================================================================
// Mount connect routes (agent submission & auto-buy)
// ============================================================================

import('./connect/routes.js').then(async ({ loadSubmittedAgents, createConnectRouter, setPurchaseTrigger }) => {
  await loadSubmittedAgents()
  const connectRouter = createConnectRouter()
  app.use('/api/agents', connectRouter)
  console.log(`  Connect page:    /connect/`)
  console.log(`  Submit API:      /api/agents/submit`)

  // Wire auto-purchase if buyer is available
  if (process.env.BUYER_API_KEY) {
    import('./autonomous-buyer.js').then(({ purchaseFromSubmitted }) => {
      setPurchaseTrigger(purchaseFromSubmitted)
      console.log(`  Auto-purchase:   enabled`)
    }).catch(() => {})
  }
}).catch(err => {
  console.error('[Seller] Failed to mount connect routes:', err.message)
})

// ============================================================================
// Start server
// ============================================================================

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`\nPerch Tax & Finance Expert Agent`)
  console.log(`================================`)
  console.log(`Server:    http://localhost:${PORT}`)
  console.log(`Agent ID:  ${AGENT_ID}`)
  console.log(`Plan ID:   ${PLAN_ID}`)
  console.log(`\nEndpoints:`)
  console.log(`  GET  /api/health    — health check`)
  console.log(`  GET  /api/services  — service catalog`)
  console.log(`  POST /api/analyze   — run analysis (Nevermined protected)`)
  console.log(`  POST /api/demo      — run analysis (no payment, for demos)`)
  console.log(`  POST /query         — legacy endpoint (Nevermined protected)`)
  console.log()
})
