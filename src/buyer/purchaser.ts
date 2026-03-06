// Autonomous Buyer — Purchase Executor

import { Payments } from '@nevermined-io/payments'
import type { DiscoveredAgent, PurchaseRecord } from './types.js'
import { scoreResponse } from './evaluator.js'

export async function executePurchase(
  payments: Payments,
  agent: DiscoveredAgent,
  queryPayload: Record<string, unknown>,
): Promise<PurchaseRecord> {
  const start = Date.now()
  const record: PurchaseRecord = {
    id: `purchase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    agentId: agent.agentId,
    agentName: agent.name,
    planId: agent.planId,
    queryType: (queryPayload.query_type as string) || 'query',
    creditsCost: 1,
    responseStatus: 0,
    responseTimeMs: 0,
    satisfactionScore: 0,
    responsePreview: '',
    success: false,
  }

  try {
    // Step 1: Order the plan (idempotent — safe to call repeatedly)
    console.log(`[Purchase] Ordering plan ${agent.planId.slice(0, 16)}...`)
    try {
      await payments.plans.orderPlan(agent.planId)
    } catch (err: any) {
      // "already ordered" is fine
      if (!err.message?.includes('already') && !err.message?.includes('duplicate')) {
        console.log(`[Purchase] Order note: ${err.message?.slice(0, 60)}`)
      }
    }

    // Step 2: Get x402 access token
    console.log(`[Purchase] Getting x402 token for agent ${agent.name}...`)
    const { accessToken } = await payments.x402.getX402AccessToken(agent.planId, agent.agentId)

    // Step 3: Find the endpoint to call
    const queryType = queryPayload.query_type as string | undefined
    const primaryEndpoint = findBestEndpoint(agent, queryType)
    if (!primaryEndpoint) {
      record.error = 'No callable endpoint found'
      record.responseTimeMs = Date.now() - start
      console.log(`[Purchase] No endpoint found for ${agent.name}`)
      return record
    }

    // Build fallback endpoints to try
    const base = agent.endpoint.replace(/\/$/, '')
    const endpoints = [primaryEndpoint]
    if (queryType && !primaryEndpoint.endsWith(`/${queryType}`)) endpoints.push(`${base}/${queryType}`)
    if (!primaryEndpoint.endsWith('/query')) endpoints.push(`${base}/query`)
    // Dedupe
    const uniqueEndpoints = [...new Set(endpoints)]

    // Step 4: Call the agent — try endpoints in order
    let resp: Response | null = null
    let usedEndpoint = ''
    for (const ep of uniqueEndpoints) {
      try {
        console.log(`[Purchase] Trying ${ep}...`)
        resp = await fetch(ep, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'payment-signature': accessToken,
          },
          body: JSON.stringify(queryPayload),
          signal: AbortSignal.timeout(30000),
        })
        usedEndpoint = ep
        if (resp.status < 500) break // Accept any non-server-error
      } catch (err: any) {
        console.log(`[Purchase] ${ep} failed: ${err.message?.slice(0, 60)}`)
        resp = null
      }
    }

    if (!resp) {
      record.error = `All endpoints failed for ${agent.name}`
      record.responseTimeMs = Date.now() - start
      return record
    }

    console.log(`[Purchase] Got ${resp.status} from ${usedEndpoint}`)

    record.responseStatus = resp.status
    record.responseTimeMs = Date.now() - start

    const body = await resp.text()
    record.responsePreview = body.slice(0, 200)

    let parsed: any = null
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = { raw: body.slice(0, 500) }
    }

    // Step 5: Score the response
    record.satisfactionScore = scoreResponse(parsed, resp.status)
    record.success = resp.status >= 200 && resp.status < 400

    // Try to extract credit cost from response
    if (parsed?.credits_used) record.creditsCost = parsed.credits_used
    else if (parsed?.result?.credits_used) record.creditsCost = parsed.result.credits_used

    console.log(`[Purchase] ${agent.name}: ${resp.status} (${record.responseTimeMs}ms, satisfaction: ${record.satisfactionScore})`)
  } catch (err: any) {
    record.error = err.message
    record.responseTimeMs = Date.now() - start
    console.log(`[Purchase] Error with ${agent.name}: ${err.message?.slice(0, 80)}`)
  }

  return record
}

function findBestEndpoint(agent: DiscoveredAgent, queryType?: string): string {
  if (!agent.endpoint) return ''
  const ep = agent.endpoint.replace(/\/$/, '')
  // If the endpoint already looks like a full API path, use it directly
  if (ep.includes('/api/') || ep.includes('/query') || ep.includes('/tasks')) return ep
  // If we have a service catalog and query_type, try the service path directly
  if (queryType && agent.serviceCatalog.length > 0) {
    const svc = agent.serviceCatalog.find(s => s.query_type === queryType)
    if (svc) return `${ep}/${svc.query_type.replace(/^\//, '')}`
  }
  // Otherwise try /query (common Nevermined pattern)
  return `${ep}/query`
}

// Build a reasonable query to send to an agent based on its service catalog
export function buildQuery(agent: DiscoveredAgent): Record<string, unknown> {
  // If we have a service catalog, pick the cheapest service
  if (agent.serviceCatalog.length > 0) {
    const cheapest = [...agent.serviceCatalog].sort((a, b) => a.credits - b.credits)[0]
    return {
      query_type: cheapest.query_type,
      params: {},
    }
  }

  // Generic query for unknown agents
  return {
    query: 'What services do you offer?',
    message: 'Hello from Tallyfor AI autonomous buyer agent',
  }
}
