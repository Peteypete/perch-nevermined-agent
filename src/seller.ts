import 'dotenv/config'
import express, { Request, Response } from 'express'
import { Payments, buildPaymentRequired } from '@nevermined-io/payments'

const app = express()
app.use(express.json())

const payments = Payments.getInstance({
  nvmApiKey: process.env.NVM_API_KEY!,
  environment: 'sandbox'
})

const PLAN_ID = process.env.NVM_PLAN_ID!
const AGENT_ID = process.env.NVM_AGENT_ID!

app.post('/query', async (req: Request, res: Response) => {
  const paymentRequired = buildPaymentRequired(PLAN_ID, {
    endpoint: '/query',
    agentId: AGENT_ID,
    httpVerb: 'POST'
  })

  const x402Token = req.headers['payment-signature'] as string

  // No token — tell the caller they need to pay
  if (!x402Token) {
    const paymentRequiredBase64 = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
    return res
      .status(402)
      .set('payment-required', paymentRequiredBase64)
      .json({ error: 'Payment Required' })
  }

  // Verify the payment token
  const verification = await payments.facilitator.verifyPermissions({
    paymentRequired,
    x402AccessToken: x402Token,
    maxAmount: 1n
  })

  if (!verification.isValid) {
    return res.status(402).json({ error: verification.invalidReason })
  }

  // ✅ Payment verified — run your service logic here
  const result = `Hello World from Perch Agent! You asked: ${JSON.stringify(req.body)}`

  // Settle (burn) the credits
  await payments.facilitator.settlePermissions({
    paymentRequired,
    x402AccessToken: x402Token,
    maxAmount: 1n,
    agentRequestId: verification.agentRequestId
  })

  return res.json({ result })
})

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', agentId: AGENT_ID, planId: PLAN_ID })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Perch seller agent running on http://localhost:${PORT}`)
  console.log(`Agent ID: ${AGENT_ID}`)
  console.log(`Plan ID:  ${PLAN_ID}`)
})
