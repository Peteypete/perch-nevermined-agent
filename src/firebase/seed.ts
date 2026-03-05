// Seed Firebase with demo data — 5 Austin STR properties, 12 ledger entries
// Run: npx ts-node --esm src/firebase/seed.ts

import 'dotenv/config'
import { db, rtdb } from './config.js'

async function seed() {
  console.log('Seeding Firestore...')

  // ============================================================================
  // Owner
  // ============================================================================
  const owner = {
    id: 'owner-01',
    name: 'Alex Morgan',
    email: 'alex@example.com',
    w2Income: 145_000,
    filingStatus: 'single',
    entities: ['entity-01', 'entity-02'],
  }
  await db.collection('owners').doc(owner.id).set(owner)
  console.log('  Owner: Alex Morgan')

  // ============================================================================
  // Entities
  // ============================================================================
  const entities = [
    {
      id: 'entity-01',
      ownerId: 'owner-01',
      name: 'Morgan STR Holdings LLC',
      type: 'llc',
      ein: '87-1234567',
      properties: ['prop-01', 'prop-02', 'prop-03'],
    },
    {
      id: 'entity-02',
      ownerId: 'owner-01',
      name: 'Alex Morgan Schedule E',
      type: 'schedule_e',
      properties: ['prop-04', 'prop-05'],
    },
  ]
  for (const entity of entities) {
    await db.collection('entities').doc(entity.id).set(entity)
    console.log(`  Entity: ${entity.name}`)
  }

  // ============================================================================
  // Properties — 5 Austin STR units
  // ============================================================================
  const properties = [
    {
      id: 'prop-01',
      entityId: 'entity-01',
      name: 'SoCo Modern Loft',
      address: '1847 S Congress Ave',
      city: 'Austin',
      state: 'TX',
      nightlyRate: 225,
      cleaningFee: 125,
      avgOccupancy: 0.78,
      monthlyExpenses: 2800,
      purchasePrice: 485_000,
      purchaseDate: '2021-03-15',
      depreciationBasis: 388_000,
      materialParticipationHours: 820,
      ytdRevenue: 42_500,
      ytdExpenses: 18_200,
      status: 'active',
    },
    {
      id: 'prop-02',
      entityId: 'entity-01',
      name: 'Domain Studio',
      address: '3200 Palm Way #412',
      city: 'Austin',
      state: 'TX',
      nightlyRate: 155,
      cleaningFee: 85,
      avgOccupancy: 0.82,
      monthlyExpenses: 1900,
      purchasePrice: 320_000,
      purchaseDate: '2022-01-10',
      depreciationBasis: 256_000,
      materialParticipationHours: 780,
      ytdRevenue: 31_200,
      ytdExpenses: 12_800,
      status: 'active',
    },
    {
      id: 'prop-03',
      entityId: 'entity-01',
      name: 'Zilker Cottage',
      address: '2105 Kinney Ave',
      city: 'Austin',
      state: 'TX',
      nightlyRate: 285,
      cleaningFee: 150,
      avgOccupancy: 0.71,
      monthlyExpenses: 3200,
      purchasePrice: 625_000,
      purchaseDate: '2022-06-01',
      depreciationBasis: 500_000,
      materialParticipationHours: 710, // KEY: 40 hours from threshold!
      ytdRevenue: 38_900,
      ytdExpenses: 21_400,
      status: 'active',
    },
    {
      id: 'prop-04',
      entityId: 'entity-02',
      name: 'East Side Bungalow',
      address: '4512 E 12th St',
      city: 'Austin',
      state: 'TX',
      nightlyRate: 175,
      cleaningFee: 95,
      avgOccupancy: 0.75,
      monthlyExpenses: 2100,
      purchasePrice: 380_000,
      purchaseDate: '2023-02-28',
      depreciationBasis: 304_000,
      materialParticipationHours: 340,
      ytdRevenue: 28_600,
      ytdExpenses: 14_700,
      status: 'active',
    },
    {
      id: 'prop-05',
      entityId: 'entity-02',
      name: 'Mueller Park Flat',
      address: '1900 Aldrich St #205',
      city: 'Austin',
      state: 'TX',
      nightlyRate: 140,
      cleaningFee: 75,
      avgOccupancy: 0.85,
      monthlyExpenses: 1650,
      purchasePrice: 295_000,
      purchaseDate: '2023-08-15',
      depreciationBasis: 236_000,
      materialParticipationHours: 290,
      ytdRevenue: 24_800,
      ytdExpenses: 11_200,
      status: 'active',
    },
  ]

  for (const prop of properties) {
    await db.collection('properties').doc(prop.id).set(prop)
    console.log(`  Property: ${prop.name} (${prop.id})`)
  }

  // ============================================================================
  // Ledger Entries — YTD financials
  // ============================================================================
  const ledger = [
    // Entity 1 — Morgan STR Holdings LLC
    { id: 'led-01', entityId: 'entity-01', propertyId: 'prop-01', date: '2025-01-31', accountCode: '4100', accountName: 'Rental Income', description: 'Jan rental income - SoCo Modern', debit: 0, credit: 14_200, category: 'revenue' },
    { id: 'led-02', entityId: 'entity-01', propertyId: 'prop-01', date: '2025-01-31', accountCode: '4200', accountName: 'Cleaning Fees', description: 'Jan cleaning fees collected - SoCo', debit: 0, credit: 1_875, category: 'revenue' },
    { id: 'led-03', entityId: 'entity-01', propertyId: 'prop-01', date: '2025-01-31', accountCode: '5100', accountName: 'Cleaning Expense', description: 'Jan cleaning crew - SoCo', debit: 1_350, credit: 0, category: 'expense' },
    { id: 'led-04', entityId: 'entity-01', propertyId: 'prop-02', date: '2025-01-31', accountCode: '4100', accountName: 'Rental Income', description: 'Jan rental income - Domain Studio', debit: 0, credit: 10_400, category: 'revenue' },
    { id: 'led-05', entityId: 'entity-01', propertyId: 'prop-02', date: '2025-01-31', accountCode: '5200', accountName: 'Repairs & Maintenance', description: 'HVAC repair - Domain Studio', debit: 450, credit: 0, category: 'expense' },
    { id: 'led-06', entityId: 'entity-01', propertyId: 'prop-03', date: '2025-01-31', accountCode: '4100', accountName: 'Rental Income', description: 'Jan rental income - Zilker Cottage', debit: 0, credit: 12_800, category: 'revenue' },
    { id: 'led-07', entityId: 'entity-01', propertyId: 'prop-03', date: '2025-01-31', accountCode: '5300', accountName: 'Utilities', description: 'Jan utilities - Zilker Cottage', debit: 380, credit: 0, category: 'expense' },
    { id: 'led-08', entityId: 'entity-01', propertyId: 'prop-03', date: '2025-01-31', accountCode: '6200', accountName: 'Property Tax', description: 'Q1 property tax - Zilker Cottage', debit: 2_600, credit: 0, category: 'expense' },

    // Entity 2 — Schedule E
    { id: 'led-09', entityId: 'entity-02', propertyId: 'prop-04', date: '2025-01-31', accountCode: '4100', accountName: 'Rental Income', description: 'Jan rental income - East Side', debit: 0, credit: 9_500, category: 'revenue' },
    { id: 'led-10', entityId: 'entity-02', propertyId: 'prop-04', date: '2025-01-31', accountCode: '5400', accountName: 'Insurance', description: 'Monthly insurance - East Side', debit: 280, credit: 0, category: 'expense' },
    { id: 'led-11', entityId: 'entity-02', propertyId: 'prop-05', date: '2025-01-31', accountCode: '4100', accountName: 'Rental Income', description: 'Jan rental income - Mueller Park', debit: 0, credit: 8_200, category: 'revenue' },
    { id: 'led-12', entityId: 'entity-02', propertyId: 'prop-05', date: '2025-01-31', accountCode: '5500', accountName: 'Management Fees', description: 'Property management - Mueller Park', debit: 820, credit: 0, category: 'expense' },
  ]

  for (const entry of ledger) {
    await db.collection('ledger').doc(entry.id).set(entry)
  }
  console.log(`  Ledger: ${ledger.length} entries`)

  // ============================================================================
  // RTDB — Agent State
  // ============================================================================
  console.log('\nSeeding Realtime Database...')

  await rtdb.ref('/').set({
    agent: {
      status: 'online',
      lastActive: new Date().toISOString(),
      version: '1.0.0',
    },
    wallet: {
      balance: 25_000,
      currency: 'USD',
      transactions: [],
    },
    stats: {
      totalQueries: 0,
      totalCreditsEarned: 0,
      queriesByType: {},
    },
  })
  console.log('  Agent state, wallet, stats')

  console.log('\nSeed complete!')
  process.exit(0)
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
