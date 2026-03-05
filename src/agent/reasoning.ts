// Claude API reasoning layer — generates human-readable analysis narratives

import AnthropicModule from '@anthropic-ai/sdk'
import type { QueryType } from '../types.js'

// Handle both ESM default and CJS module.exports
const Anthropic = (AnthropicModule as any).default || AnthropicModule

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

const SYSTEM_PROMPT = `You are Perch, an expert AI tax and financial analyst specializing in short-term rental (STR) real estate portfolios. You provide clear, actionable financial analysis.

When given analysis data, provide a concise narrative summary that:
1. Highlights the most important findings
2. Identifies risks or opportunities
3. Gives specific, actionable recommendations
4. Uses actual dollar amounts from the data

Keep responses under 200 words. Be direct and specific. Use bullet points for clarity.`

export async function generateNarrative(
  queryType: QueryType,
  data: unknown,
  userQuery?: string
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return formatFallbackNarrative(queryType, data)
  }

  const prompt = userQuery
    ? `User question: "${userQuery}"\n\nAnalysis data:\n${JSON.stringify(data, null, 2)}\n\nProvide a clear, actionable response to the user's question using the analysis data.`
    : `Analysis type: ${queryType}\n\nData:\n${JSON.stringify(data, null, 2)}\n\nProvide a concise narrative summary of these findings with key insights and recommendations.`

  const response = await getClient().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
  })

  const textBlock = response.content.find((b: any) => b.type === 'text') as any
  return textBlock ? textBlock.text : 'Analysis complete.'
}

// Fallback when no API key — generate a simple summary from data
function formatFallbackNarrative(queryType: QueryType, data: any): string {
  switch (queryType) {
    case 'property_noi':
      return `${data.property?.name}: YTD NOI of $${data.ytd?.noi?.toLocaleString()} (${data.ytd?.noiMargin}% margin). ` +
        `Projected annual NOI: $${data.annualProjection?.projectedNOI?.toLocaleString()}. ` +
        (data.materialParticipation?.status === 'near_threshold'
          ? `Material participation: ${data.materialParticipation.hoursRemaining} hours remaining.`
          : `Material participation: ${data.materialParticipation?.status}.`)

    case 'qbi_analysis':
      return `QBI Status: ${data.qbiAnalysis?.status}. ` +
        `Deduction: $${data.qbiAnalysis?.actualDeduction?.toLocaleString()} ` +
        `(saves ~$${data.qbiAnalysis?.taxSavings?.toLocaleString()} in taxes). ` +
        (data.qbiAnalysis?.warning || '')

    case 'portfolio_report':
      return `Portfolio: ${data.portfolio?.totalProperties} properties, ` +
        `$${data.portfolio?.totalRevenue?.toLocaleString()} revenue, ` +
        `$${data.portfolio?.totalNetIncome?.toLocaleString()} net income ` +
        `(${data.portfolio?.overallNOIMargin}% margin). ` +
        (data.alerts?.length > 0 ? `Alerts: ${data.alerts.join('; ')}` : 'No alerts.')

    case 'entity_recommendation':
      return `Recommendation: ${data.recommendation === 's_corp' ? 'S-Corp' : 'Schedule E'}. ${data.reasoning}`

    default:
      return 'Analysis complete. See data for details.'
  }
}
