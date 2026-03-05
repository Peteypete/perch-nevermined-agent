import 'dotenv/config'
import { Payments } from '@nevermined-io/payments'

const PLAN_ID = process.env.NVM_PLAN_ID!
const AGENT_ID = process.env.NVM_AGENT_ID!
const SELLER_URL = process.env.SELLER_URL || 'http://localhost:3000'

async function main() {
  const payments = Payments.getInstance({
    nvmApiKey: process.env.NVM_API_KEY!,
    environment: 'sandbox'
  })

  console.log('1. Ordering plan...')
  await payments.plans.orderPlan(PLAN_ID)

  console.log('2. Checking balance...')
  const balance = await payments.plans.getPlanBalance(PLAN_ID)
  console.log(`   Balance: ${balance.balance} credits`)

  console.log('3. Getting access token...')
  const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID, AGENT_ID)
  console.log(`   Token: ${accessToken.slice(0, 40)}...`)

  console.log(`4. Calling seller at ${SELLER_URL}/query...`)
  const response = await fetch(`${SELLER_URL}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'payment-signature': accessToken
    },
    body: JSON.stringify({ prompt: 'Hello from the buyer!' })
  })

  const data = await response.json()
  console.log(`\n✅ Response (${response.status}):`, JSON.stringify(data, null, 2))
}

main().catch(console.error)
