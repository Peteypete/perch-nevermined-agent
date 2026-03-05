import 'dotenv/config'
import { Payments } from '@nevermined-io/payments'

async function main() {
  const payments = Payments.getInstance({
    nvmApiKey: process.env.NVM_API_KEY!,
    environment: 'sandbox'
  })

  const { agentId, planId } = await payments.agents.registerAgentAndPlan(
    {
      name: 'Perch Tax & Finance Expert',
      description: 'AI-powered real estate tax analysis for STR portfolios. Services: property NOI, federal tax projection, QBI deduction analysis, expense classification, portfolio reports, entity structure recommendations.',
      tags: ['ai', 'tax', 'real-estate', 'str', 'finance', 'qbi'],
      dateCreated: new Date()
    },
    {
      endpoints: [{ POST: `${process.env.AGENT_URL || 'http://localhost:3000'}/api/analyze` }],
      agentDefinitionUrl: `${process.env.AGENT_URL || 'http://localhost:3000'}/api/services`,
    },
    {
      name: 'Perch Analysis Credits',
      description: '100 analysis credits — free for hackathon. Services cost 1-5 credits each.',
      dateCreated: new Date()
    },
    payments.plans.getFreePriceConfig(),
    payments.plans.getFixedCreditsConfig(100n, 1n)
  )

  console.log(`Agent registered successfully!`)
  console.log(`Agent ID: ${agentId}`)
  console.log(`Plan ID:  ${planId}`)
  console.log(`\nAdd these to your .env:`)
  console.log(`NVM_AGENT_ID=${agentId}`)
  console.log(`NVM_PLAN_ID=${planId}`)
}

main().catch(console.error)
