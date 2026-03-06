import 'dotenv/config'
import { Payments } from '@nevermined-io/payments'

const PLAN_ID = process.env.NVM_PLAN_ID!
const AGENT_ID = process.env.NVM_AGENT_ID!
const SELLER_URL = process.env.SELLER_URL || 'http://localhost:3000'

const payments = Payments.getInstance({
  nvmApiKey: process.env.BUYER_API_KEY!,
  environment: 'sandbox'
})

console.log('=== Tallyfor AI Buyer Test ===\n')

console.log('1. Ordering plan...')
await payments.plans.orderPlan(PLAN_ID)
console.log('   Plan ordered!')

console.log('\n2. Checking balance...')
const balance = await payments.plans.getPlanBalance(PLAN_ID)
console.log(`   Balance: ${balance.balance} credits`)

console.log('\n3. Getting access token...')
const { accessToken } = await payments.x402.getX402AccessToken(PLAN_ID, AGENT_ID)
console.log(`   Token: ${accessToken.slice(0, 50)}...`)

// --- Test 1: Property NOI Analysis (2 credits) ---
console.log('\n4. Requesting Property NOI Analysis (Zilker Cottage)...')
const noiResponse = await fetch(`${SELLER_URL}/query`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'payment-signature': accessToken
  },
  body: JSON.stringify({
    query_type: 'property_noi',
    params: { property_id: 'prop-03' }
  })
})
const noiData = await noiResponse.json() as any
console.log(`   Status: ${noiResponse.status}`)
if (noiData.result?.data) {
  const d = noiData.result.data
  console.log(`   Property: ${d.property?.name}`)
  console.log(`   YTD NOI: $${d.ytd?.noi?.toLocaleString()} (${d.ytd?.noiMargin}% margin)`)
  console.log(`   Material Participation: ${d.materialParticipation?.currentHours}/${d.materialParticipation?.threshold} hours (${d.materialParticipation?.status})`)
  console.log(`   Cap Rate: ${d.capRate}%`)
} else {
  console.log(`   Response:`, JSON.stringify(noiData, null, 2))
}

// --- Test 2: QBI Analysis (5 credits) ---
console.log('\n5. Requesting QBI Analysis...')
const { accessToken: token2 } = await payments.x402.getX402AccessToken(PLAN_ID, AGENT_ID)
const qbiResponse = await fetch(`${SELLER_URL}/query`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'payment-signature': token2
  },
  body: JSON.stringify({
    query_type: 'qbi_analysis',
    params: { owner_id: 'owner-01' }
  })
})
const qbiData = await qbiResponse.json() as any
console.log(`   Status: ${qbiResponse.status}`)
if (qbiData.result?.data) {
  const d = qbiData.result.data
  console.log(`   Owner: ${d.owner?.name}`)
  console.log(`   Total STR Income: $${d.totalSTRIncome?.toLocaleString()}`)
  console.log(`   Total AGI: $${d.totalAGI?.toLocaleString()}`)
  console.log(`   QBI Deduction: $${d.qbiAnalysis?.actualDeduction?.toLocaleString()} (${d.qbiAnalysis?.status})`)
  console.log(`   Tax Savings: $${d.qbiAnalysis?.taxSavings?.toLocaleString()}`)
  if (d.qbiAnalysis?.warning) console.log(`   Warning: ${d.qbiAnalysis.warning}`)
} else {
  console.log(`   Response:`, JSON.stringify(qbiData, null, 2))
}

// --- Check final balance ---
console.log('\n6. Checking remaining balance...')
const finalBalance = await payments.plans.getPlanBalance(PLAN_ID)
console.log(`   Remaining: ${finalBalance.balance} credits`)

console.log('\n=== End-to-end test complete! ===')
