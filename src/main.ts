// Combined entry point — starts seller + autonomous buyer in one process
// Railway only exposes one port (seller on $PORT), buyer runs its loop internally

import './seller.js'

// Start buyer after seller is ready
setTimeout(async () => {
  console.log('\n[Main] Starting autonomous buyer...\n')
  await import('./autonomous-buyer.js')
}, 3000)
