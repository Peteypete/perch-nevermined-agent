import admin from 'firebase-admin'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

// Initialize Firebase Admin SDK
// Looks for service account key in order:
// 1. FIREBASE_SERVICE_ACCOUNT env var (JSON string)
// 2. ./firebase-service-account.json file
// 3. GOOGLE_APPLICATION_CREDENTIALS env var

let app: admin.app.App

if (!admin.apps.length) {
  const serviceAccountPath = resolve(process.cwd(), 'firebase-service-account.json')

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://perch-hackathon-default-rtdb.firebaseio.com',
    })
  } else if (existsSync(serviceAccountPath)) {
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf-8'))
    app = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: 'https://perch-hackathon-default-rtdb.firebaseio.com',
    })
  } else {
    app = admin.initializeApp({
      databaseURL: 'https://perch-hackathon-default-rtdb.firebaseio.com',
    })
  }
} else {
  app = admin.apps[0]!
}

export const db = admin.firestore(app)
export const rtdb = admin.database(app)
export { admin }
