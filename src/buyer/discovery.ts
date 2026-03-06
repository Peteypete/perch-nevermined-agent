// Autonomous Buyer — Agent Discovery

import { Payments } from '@nevermined-io/payments'
import type { DiscoveredAgent, ServiceInfo } from './types.js'

const OWN_PLAN_ID = process.env.NVM_PLAN_ID || ''
const OWN_AGENT_ID = process.env.NVM_AGENT_ID || ''

export async function discoverAgents(payments: Payments): Promise<DiscoveredAgent[]> {
  const agents: DiscoveredAgent[] = []
  const seenAgents = new Set<string>()

  console.log('[Discovery] Scanning Nevermined sandbox for agents...')

  // Paginate through all plans
  for (let page = 1; page <= 20; page++) {
    try {
      const plansResult = await payments.plans.getPlans(page, 10, 'createdAt', 'desc')
      const plans = plansResult?.plans || plansResult?.results || plansResult || []

      if (!Array.isArray(plans) || plans.length === 0) {
        console.log(`[Discovery] No more plans at page ${page}`)
        break
      }

      console.log(`[Discovery] Page ${page}: found ${plans.length} plans`)

      for (const plan of plans) {
        const planId = plan.did || plan.planId || plan.id || ''
        if (!planId) continue

        try {
          // Get agents associated with this plan
          const agentsResult = await payments.plans.getAgentsAssociatedToAPlan(planId)
          const planAgents = agentsResult?.agents || agentsResult?.results || agentsResult || []

          if (!Array.isArray(planAgents)) continue

          for (const agent of planAgents) {
            const agentId = agent.did || agent.agentId || agent.id || ''
            if (!agentId || seenAgents.has(agentId) || agentId === OWN_AGENT_ID) continue
            seenAgents.add(agentId)

            // Try to get agent details
            let agentDetails: any = agent
            try {
              agentDetails = await payments.agents.getAgent(agentId)
            } catch {
              // Use what we have from the plan listing
            }

            // Extract endpoint from agent metadata
            const endpoint = extractEndpoint(agentDetails)
            const serviceCatalog = await fetchServiceCatalog(endpoint)

            agents.push({
              agentId,
              planId,
              name: agentDetails.metadata?.main?.name || agentDetails.name || `Agent ${agentId.slice(0, 12)}`,
              description: agentDetails.metadata?.main?.description || agentDetails.description || '',
              tags: agentDetails.metadata?.main?.tags || agentDetails.tags || [],
              endpoint,
              creditsPerPlan: Number(plan.creditsGranted || plan.credits || 100),
              serviceCatalog,
            })
          }
        } catch (err: any) {
          // Skip plans we can't query agents for
          console.log(`[Discovery] Skipping plan ${planId.slice(0, 16)}...: ${err.message?.slice(0, 60)}`)
        }
      }
    } catch (err: any) {
      console.log(`[Discovery] Error on page ${page}: ${err.message?.slice(0, 60)}`)
      break
    }
  }

  console.log(`[Discovery] Found ${agents.length} agents across Nevermined sandbox`)
  return agents
}

function extractEndpoint(agent: any): string {
  const id = agent.did || agent.id || ''

  // Primary: metadata.agent.endpoints (actual Nevermined structure)
  const agentMeta = agent.metadata?.agent
  if (agentMeta?.endpoints) {
    for (const ep of agentMeta.endpoints) {
      if (typeof ep === 'string') return ep
      if (ep.POST) return ep.POST.replace(/:agentId/g, id)
      if (ep.GET) return ep.GET.replace(/:agentId/g, id)
    }
  }
  if (agentMeta?.agentDefinitionUrl) {
    // agentDefinitionUrl points to /api/services — derive base URL
    const defUrl = agentMeta.agentDefinitionUrl
    const base = defUrl.replace(/\/api\/services.*$/, '')
    if (base) return `${base}/api/analyze`
  }

  // Fallback: top-level fields
  if (agent.endpoints) {
    for (const ep of Array.isArray(agent.endpoints) ? agent.endpoints : []) {
      if (typeof ep === 'string') return ep
      if (ep.POST) return ep.POST.replace(/:agentId/g, id)
    }
  }
  if (agent.api?.endpoints) {
    for (const ep of agent.api.endpoints) {
      if (typeof ep === 'string') return ep
      if (ep.POST) return ep.POST.replace(/:agentId/g, id)
    }
  }

  // Registry URL (Nevermined protocol endpoint — last resort)
  if (agent.registry?.url) return agent.registry.url
  if (agent.metadata?.serviceEndpoint) return agent.metadata.serviceEndpoint

  if (agent.agentDefinitionUrl) return agent.agentDefinitionUrl
  if (agent.serviceUrl) return agent.serviceUrl
  if (agent.url) return agent.url
  return ''
}

async function fetchServiceCatalog(endpoint: string): Promise<ServiceInfo[]> {
  if (!endpoint) return []

  // Try common service catalog endpoints
  const baseUrl = endpoint.replace(/\/api\/.*$/, '').replace(/\/$/, '')
  const catalogUrls = [
    `${baseUrl}/api/services`,
    `${baseUrl}/api/v1/services`,
    `${baseUrl}/.well-known/ai-plugin.json`,
  ]

  for (const url of catalogUrls) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!resp.ok) continue
      const data = await resp.json() as any

      if (data.services && Array.isArray(data.services)) {
        return data.services.map((s: any) => ({
          query_type: s.query_type || s.name || 'query',
          credits: s.credits || 1,
          description: s.description || '',
        }))
      }
    } catch {
      // Try next URL
    }
  }

  return []
}
