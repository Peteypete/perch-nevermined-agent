// Autonomous Buyer — Budget Manager

import type { PurchaseRecord } from './types.js'

export class BudgetManager {
  private totalBudget: number
  private spent = 0
  private purchases: PurchaseRecord[] = []
  private uniqueAgents = new Set<string>()

  constructor(totalBudget = 50) {
    this.totalBudget = totalBudget
  }

  get remaining(): number {
    return this.totalBudget - this.spent
  }

  get transactionCount(): number {
    return this.purchases.filter(p => p.success).length
  }

  get uniqueAgentCount(): number {
    return this.uniqueAgents.size
  }

  canAfford(cost: number): boolean {
    return this.remaining >= cost
  }

  recordPurchase(record: PurchaseRecord): void {
    this.purchases.push(record)
    if (record.success) {
      this.spent += record.creditsCost
      this.uniqueAgents.add(record.agentId)
    }
  }

  getStatus() {
    return {
      totalBudget: this.totalBudget,
      spent: this.spent,
      remaining: this.remaining,
      totalTransactions: this.transactionCount,
      uniqueAgents: this.uniqueAgentCount,
      uniqueAgentIds: [...this.uniqueAgents],
    }
  }

  getPurchases(): PurchaseRecord[] {
    return [...this.purchases].reverse()
  }

  getPurchasesForAgent(agentId: string): PurchaseRecord[] {
    return this.purchases.filter(p => p.agentId === agentId)
  }
}
