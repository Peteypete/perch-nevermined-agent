import { setGlobalOptions } from 'firebase-functions'
import { onRequest } from 'firebase-functions/https'
import { defineSecret } from 'firebase-functions/params'
import { Payments, buildPaymentRequired } from '@nevermined-io/payments'
import express, { Request, Response } from 'express'

setGlobalOptions({ maxInstances: 10 })

const NVM_API_KEY = defineSecret('NVM_API_KEY')
const NVM_AGENT_ID = defineSecret('NVM_AGENT_ID')
const NVM_PLAN_ID = defineSecret('NVM_PLAN_ID')

const app = express()
app.use(express.json())

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' })
})

app.post('/query', async (req: Request, res: Response) => {
  const payments = Payments.getInstance({
    nvmApiKey: NVM_API_KEY.value(),
    environment: 'sandbox'
  })

  const planId = NVM_PLAN_ID.value()
  const agentId = NVM_AGENT_ID.value()

  const paymentRequired = buildPaymentRequired(planId, {
    endpoint: '/query',
    agentId,
    httpVerb: 'POST'
  })

  const x402Token = req.headers['payment-signature'] as string

  if (!x402Token) {
    const paymentRequiredBase64 = Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
    return res
      .status(402)
      .set('payment-required', paymentRequiredBase64)
      .json({ error: 'Payment Required' })
  }

  const verification = await payments.facilitator.verifyPermissions({
    paymentRequired,
    x402AccessToken: x402Token,
    maxAmount: 1n
  })

  if (!verification.isValid) {
    return res.status(402).json({ error: verification.invalidReason })
  }

  const result = `Hello World from Perch Agent! You asked: ${JSON.stringify(req.body)}`

  await payments.facilitator.settlePermissions({
    paymentRequired,
    x402AccessToken: x402Token,
    maxAmount: 1n,
    agentRequestId: verification.agentRequestId
  })

  return res.json({ result })
})

export const seller = onRequest({ secrets: [NVM_API_KEY, NVM_AGENT_ID, NVM_PLAN_ID] }, app)
