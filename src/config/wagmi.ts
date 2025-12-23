import { http, createConfig } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { arcTestnet } from './chains'

// === Injected wallets (MetaMask, Rabby, Rainbow, Coinbase Extension, etc)
const injectedConnector = injected({
  shimDisconnect: true,
})

// === WalletConnect
// Ensure projectId is a valid non-empty string before initializing
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID
const hasValidProjectId = walletConnectProjectId && 
                          typeof walletConnectProjectId === 'string' && 
                          walletConnectProjectId.trim().length > 0

// Error handling for missing projectId
if (!hasValidProjectId) {
  const isProduction = (import.meta.env as { MODE?: string }).MODE === 'production'
  const errorMsg = '⚠️ [wagmi] WalletConnect is not configured (missing VITE_WALLETCONNECT_PROJECT_ID).'
  const helpMsg = 'Please configure VITE_WALLETCONNECT_PROJECT_ID in your environment variables. Create a project at https://cloud.walletconnect.com'
  
  if (isProduction) {
    console.error(errorMsg)
    console.error(helpMsg)
  } else {
    console.warn(errorMsg)
    console.warn(helpMsg)
  }
}

// Only create WalletConnect connector if projectId is valid
// This prevents "Cannot read properties of undefined (reading 'init')" error
const walletConnectConnector = hasValidProjectId
  ? walletConnect({
      projectId: walletConnectProjectId.trim(),
      showQrModal: true,
      metadata: {
        name: 'Arc Network',
        description: 'Arc minter dApp',
        url: 'https://www.fajucar.xyz',
        icons: ['https://www.fajucar.xyz/favicon.ico'],
      },
    })
  : null

// Export projectId for use in components (only if valid)
export const WALLETCONNECT_PROJECT_ID = hasValidProjectId ? walletConnectProjectId.trim() : ''

// Priorizar WalletConnect quando window.ethereum não existir (mobile/outros navegadores)
// No desktop com MetaMask, priorizar injected (MetaMask)
const hasInjectedWallet = typeof window !== 'undefined' && typeof window.ethereum !== 'undefined'
const connectors = hasInjectedWallet
  ? [
      // Desktop: MetaMask injected primeiro
      injectedConnector,
      ...(walletConnectConnector ? [walletConnectConnector] : []),
    ]
  : [
      // Mobile/sem injected: WalletConnect primeiro
      ...(walletConnectConnector ? [walletConnectConnector] : []),
      injectedConnector,
    ]

export const config = createConfig({
  // DEP: mantenha o dApp restrito à Arc Testnet.
  // Isso evita bugs de mismatch de chain/RPC (especialmente após confirmar na carteira).
  chains: [arcTestnet],
  connectors,
  transports: {
    // RPC explícito e estável (Arc não é garantida em providers "default").
    [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
  },
  ssr: false,
})
