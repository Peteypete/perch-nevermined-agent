import 'dotenv/config'
import { Payments } from '@nevermined-io/payments'

const payments = Payments.getInstance({
  nvmApiKey: process.env.BUYER_API_KEY!,
  environment: 'sandbox'
})

console.log('Calling orderFiatPlan...')
try {
  const result = await payments.plans.orderFiatPlan(process.env.NVM_PLAN_ID!)
  console.log('Result:', JSON.stringify(result, null, 2))
} catch (err: any) {
  console.error('Error message:', err?.message)
  console.error('Error code:', err?.code)
  console.error('Full error:', String(err))
}
