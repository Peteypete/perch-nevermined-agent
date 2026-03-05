import 'dotenv/config'
import { Payments } from '@nevermined-io/payments'

const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

async function main() {
  const payments = Payments.getInstance({
    nvmApiKey: process.env.NVM_API_KEY!,
    environment: 'sandbox'
  })

  const { agentId, planId } = await payments.agents.registerAgentAndPlan(
    {
      name: 'My AI Assistant',
      description: 'A paid service',
      tags: ['ai', 'payments'],
      dateCreated: new Date()
    },
    {
      endpoints: [{ POST: 'https://your-api.com/query' }],
      agentDefinitionUrl: 'https://your-api.com/openapi.json'
    },
    {
      name: 'Starter Plan',
      description: '100 requests for $10',
      dateCreated: new Date()
    },
    payments.plans.getERC20PriceConfig(
      10_000_000n,
      USDC_ADDRESS,
      process.env.BUILDER_ADDRESS! as `0x${string}`
    ),
    payments.plans.getFixedCreditsConfig(100n, 1n)
  )

  console.log(`Agent ID: ${agentId}`)
  console.log(`Plan ID: ${planId}`)
}

main().catch(console.error)
