import { http, createConfig } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'
import { arcTestnet } from './chains'

// === Injected wallets (MetaMask, Rabby, Rainbow, Coinbase Extension, etc)
const injectedConnector = injected({
  shimDisconnect: true,
})

// === WalletConnect (somente se projectId existir)
const walletConnectConnector =
  import.meta.env.VITE_WALLETCONNECT_PROJECT_ID
    ? walletConnect({
        projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
        metadata: {
          name: 'Arc Network',
          description: 'Blockchain with deterministic finality',
          url: 'https://arc.network',
          icons: ['https://arc.network/logo.png'],
        },
        showQrModal: true,
      })
    : null

export const config = createConfig({
  // DEP: mantenha o dApp restrito à Arc Testnet.
  // Isso evita bugs de mismatch de chain/RPC (especialmente após confirmar na carteira).
  chains: [arcTestnet],
  connectors: [
    injectedConnector,
    ...(walletConnectConnector ? [walletConnectConnector] : []),
  ],
  transports: {
    // RPC explícito e estável (Arc não é garantida em providers "default").
    [arcTestnet.id]: http(arcTestnet.rpcUrls.default.http[0]),
  },
  ssr: false,
})
