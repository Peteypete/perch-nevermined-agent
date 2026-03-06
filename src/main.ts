// Combined entry point — starts seller + autonomous buyer in one process
// Railway only exposes one port (seller on $PORT), buyer runs its loop internally

import './seller.js'

// Start buyer after seller is ready — wrapped so it never kills the seller
setTimeout(async () => {
  if (!process.env.BUYER_API_KEY) {
    console.log('\n[Main] BUYER_API_KEY not set — skipping autonomous buyer\n')
    return
  }
  try {
    console.log('\n[Main] Starting autonomous buyer...\n')
    await import('./autonomous-buyer.js')
  } catch (err: any) {
    console.error('[Main] Buyer failed to start:', err.message)
  }
}, 3000)
