import 'dotenv/config'
import express, { Request, Response } from 'express'
import cors from 'cors'
import { handleAnalysisRequest, getCreditsForQuery } from './agent/handler.js'
import { SERVICE_CATALOG } from './types.js'
import type { AnalysisRequest, QueryType } from './types.js'
import { rtdb } from './firebase/config.js'

const app = express()
app.use(express.json())
app.use(cors())

// Lazy init — Nevermined SDK crashes if API key is invalid/placeholder
let _paymentsModule: any = null
let _payments: any = null

async function loadPayments() {
  if (!_paymentsModule) {
    _paymentsModule = await import('@nevermined-io/payments')
  }
  return _paymentsModule
}

async function getPayments() {
  if (!_payments) {
    const mod = await loadPayments()
    _payments = mod.Payments.getInstance({
      nvmApiKey: process.env.NVM_API_KEY!,
      environment: 'sandbox'
    })
  }
  return _payments
}

async function buildPaymentReq(planId: string, opts: any) {
  const mod = await loadPayments()
  return mod.buildPaymentRequired(planId, opts)
}

const PLAN_ID = process.env.NVM_PLAN_ID || ''
const AGENT_ID = process.env.NVM_AGENT_ID || ''

// ============================================================================
// Service Catalog — what we sell
// ============================================================================

app.get('/api/services', (_req: Request, res: Response) => {
  res.json({
    agent: 'Perch Tax & Finance Expert',
    description: 'AI-powered real estate tax analysis, QBI optimization, and financial reporting for STR portfolios',
    planId: PLAN_ID,
    services: Object.entries(SERVICE_CATALOG).map(([type, info]) => ({
      query_type: type,
      credits: info.credits,
      description: info.description,
    })),
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
  try {
    const result = await handleAnalysisRequest(body)

    // Settle (burn) the credits
    await payments.facilitator.settlePermissions({
      paymentRequired,
      x402AccessToken: x402Token,
      maxAmount: BigInt(credits),
      agentRequestId: verification.agentRequestId,
    })

    res.json(result)
  } catch (err: any) {
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

    await payments.facilitator.settlePermissions({
      paymentRequired,
      x402AccessToken: x402Token,
      maxAmount: 1n,
      agentRequestId: verification.agentRequestId,
    })

    res.json({ result })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
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
