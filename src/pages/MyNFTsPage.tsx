import { useState, useEffect, useRef } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { getAddress } from 'viem'
import { CONTRACT_ADDRESSES } from '@/config/contracts'
import { Loader2, RefreshCw, ExternalLink, Copy, CheckCircle2, Image as ImageIcon, Info, Wallet } from 'lucide-react'
import toast from 'react-hot-toast'
import { useWalletModal } from '@/contexts/WalletModalContext'
import FajuARC_ABI from '@/abis/FajuARC.json'

interface NFTInfo {
  tokenId: string
  tokenURI: string
  owner: string
}

interface NFTMetadata {
  name?: string
  description?: string
  image?: string
}

// Helper para converter IPFS para HTTP
function ipfsToHttp(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.replace('ipfs://', '')}`
  }
  if (uri.startsWith('https://')) {
    return uri
  }
  if (uri.startsWith('http://')) {
    return uri
  }
  return uri
}

// Helper para detectar mobile
function isMobile(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(pointer: coarse)').matches || 
         /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
}

export function MyNFTsPage() {
  const { address, isConnected } = useAccount()
  const publicClient = usePublicClient()
  const { openModal } = useWalletModal()
  const [nfts, setNfts] = useState<NFTInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [showImportInstructions, setShowImportInstructions] = useState(false)
  const autoPromptedRef = useRef(false)

  // Priorizar VITE_ARC_COLLECTION_ADDRESS, fallback para VITE_GIFT_CARD_NFT_ADDRESS
  const arcCollectionEnv = import.meta.env.VITE_ARC_COLLECTION_ADDRESS
  const giftCardNFT = CONTRACT_ADDRESSES.GIFT_CARD_NFT
  
  let nftContractAddress: string | null = null
  
  // Check if VITE_ARC_COLLECTION_ADDRESS is valid (not placeholder)
  if (arcCollectionEnv && 
      typeof arcCollectionEnv === 'string' &&
      arcCollectionEnv.trim() !== '' &&
      !arcCollectionEnv.includes('SEU_CONTRATO') &&
      !arcCollectionEnv.includes('YOUR_CONTRACT') &&
      /^0x[a-fA-F0-9]{40}$/i.test(arcCollectionEnv.trim())) {
    try {
      const normalized = arcCollectionEnv.trim().toLowerCase()
      nftContractAddress = getAddress(normalized)
    } catch (error) {
      console.error('Invalid VITE_ARC_COLLECTION_ADDRESS format:', error)
    }
  } 
  // Use VITE_GIFT_CARD_NFT_ADDRESS if available and valid
  else if (giftCardNFT && 
           giftCardNFT !== '' && 
           giftCardNFT !== '0x0000000000000000000000000000000000000000' &&
           /^0x[a-fA-F0-9]{40}$/i.test(giftCardNFT)) {
    try {
      nftContractAddress = getAddress(giftCardNFT)
    } catch (error) {
      console.error('Invalid GIFT_CARD_NFT address format:', error)
    }
  }

  const loadNFTs = async () => {
    if (!publicClient || !address || !nftContractAddress) {
      setNfts([])
      return
    }

    setLoading(true)
    try {
      let tokenIds: bigint[] = []

      // Estratégia 1: Tentar balanceOf + tokenOfOwnerByIndex (ERC721Enumerable - mais eficiente)
      try {
        const balance = await publicClient.readContract({
          address: nftContractAddress as `0x${string}`,
          abi: FajuARC_ABI,
          functionName: 'balanceOf',
          args: [address as `0x${string}`],
        })
        const balanceNum = Number(balance)
        console.log(`📊 balanceOf: ${balanceNum} tokens`)
        
        if (balanceNum > 0) {
          // Tentar tokenOfOwnerByIndex se disponível (pode não estar no ABI)
          try {
            const tokenIdsArray = await Promise.all(
              Array.from({ length: balanceNum }, (_, i) =>
                publicClient.readContract({
                  address: nftContractAddress as `0x${string}`,
                  abi: [
                    {
                      type: 'function',
                      name: 'tokenOfOwnerByIndex',
                      stateMutability: 'view',
                      inputs: [
                        { name: 'owner', type: 'address' },
                        { name: 'index', type: 'uint256' },
                      ],
                      outputs: [{ name: '', type: 'uint256' }],
                    },
                  ],
                  functionName: 'tokenOfOwnerByIndex',
                  args: [address as `0x${string}`, BigInt(i)],
                }).catch(() => null)
              )
            )
            const validTokenIds = tokenIdsArray
              .filter((id): id is bigint => id !== null)
              .map((id: bigint) => BigInt(id.toString()))
            if (validTokenIds.length > 0) {
              tokenIds = validTokenIds
              console.log('✅ tokenOfOwnerByIndex retornou:', tokenIds.map(id => id.toString()))
            }
          } catch (error: any) {
            console.log('ℹ️ tokenOfOwnerByIndex não disponível, usando fallback:', error.message)
          }
        }
      } catch (error: any) {
        console.warn('⚠️ balanceOf falhou, usando fallback:', error.message)
      }

      // Estratégia 2: Tentar getUserTokens do minter contract (se disponível)
      if (tokenIds.length === 0 && CONTRACT_ADDRESSES.GIFT_CARD_MINTER && CONTRACT_ADDRESSES.GIFT_CARD_MINTER !== '') {
        try {
          const minterAddress = getAddress(CONTRACT_ADDRESSES.GIFT_CARD_MINTER)
          const result = await publicClient.readContract({
            address: minterAddress,
            abi: FajuARC_ABI,
            functionName: 'getUserTokens',
            args: [address as `0x${string}`],
          })
          if (Array.isArray(result) && result.length > 0) {
            tokenIds = result.map((id: any) => BigInt(id.toString()))
            console.log('✅ getUserTokens retornou:', tokenIds.map(id => id.toString()))
          }
        } catch (error: any) {
          console.warn('⚠️ getUserTokens falhou, usando fallback:', error.message)
        }
      }

      // Estratégia 3: Se não encontrou tokens, buscar por eventos Transfer (com paginação robusta)
      if (tokenIds.length === 0) {
        try {
          const currentBlock = await publicClient.getBlockNumber()
          const maxBlocksToSearch = BigInt(10000)
          const chunkSize = BigInt(2000) // Tamanho de cada chunk para evitar limites do RPC
          const fromBlock = currentBlock > maxBlocksToSearch ? currentBlock - maxBlocksToSearch : BigInt(0)

          // Função auxiliar para buscar eventos com timeout
          const fetchLogsWithTimeout = async (
            startBlock: bigint,
            endBlock: bigint,
            timeoutMs: number = 30000
          ): Promise<any[]> => {
            const timeoutPromise = new Promise<any[]>((_, reject) => {
              setTimeout(() => reject(new Error('Timeout ao buscar eventos')), timeoutMs)
            })

            const logsPromise = publicClient.getLogs({
              address: nftContractAddress as `0x${string}`,
              event: {
                type: 'event',
                name: 'Transfer',
                inputs: [
                  { indexed: true, name: 'from', type: 'address' },
                  { indexed: true, name: 'to', type: 'address' },
                  { indexed: true, name: 'tokenId', type: 'uint256' },
                ],
              },
              args: {
                to: address as `0x${string}`,
              },
              fromBlock: startBlock,
              toBlock: endBlock,
            })

            return Promise.race([logsPromise, timeoutPromise])
          }

          // Buscar eventos em chunks paginados
          const allTransferLogs: any[] = []
          const receivedTokenIds = new Set<string>()
          let currentStart = fromBlock
          const toBlock = currentBlock
          let hasErrors = false

          console.log(`🔍 Buscando eventos Transfer de ${fromBlock} até ${toBlock} em chunks de ${chunkSize} blocos...`)

          while (currentStart <= toBlock) {
            const currentEnd = currentStart + chunkSize > toBlock ? toBlock : currentStart + chunkSize - BigInt(1)
            
            try {
              const chunkLogs = await fetchLogsWithTimeout(currentStart, currentEnd)
              allTransferLogs.push(...chunkLogs)
              console.log(`✅ Chunk ${currentStart}-${currentEnd}: ${chunkLogs.length} eventos encontrados`)
            } catch (error: any) {
              hasErrors = true
              const errorMsg = error.message || String(error)
              console.warn(`⚠️ Erro ao buscar chunk ${currentStart}-${currentEnd}:`, errorMsg)
              
              // Se for timeout ou limite do RPC, continuar com próximo chunk
              if (errorMsg.includes('Timeout') || errorMsg.includes('limit') || errorMsg.includes('range')) {
                console.log(`⏭️ Pulando chunk ${currentStart}-${currentEnd} devido a limite do RPC`)
              } else {
                // Para outros erros, pode ser que não haja mais eventos
                break
              }
            }

            currentStart = currentEnd + BigInt(1)
            
            // Pequeno delay entre chunks para não sobrecarregar o RPC
            await new Promise(resolve => setTimeout(resolve, 100))
          }

          // Deduplicar tokenIds usando Set
          allTransferLogs.forEach((log: any) => {
            if (log.args?.tokenId) {
              receivedTokenIds.add(log.args.tokenId.toString())
            }
          })

          console.log(`📊 Total de eventos únicos encontrados: ${receivedTokenIds.size}`)

          if (hasErrors && receivedTokenIds.size === 0) {
            throw new Error('Não foi possível buscar eventos devido a limites do RPC. Tente novamente mais tarde.')
          }

          // Verificar quais tokens ainda pertencem ao usuário
          for (const tokenIdStr of Array.from(receivedTokenIds)) {
            try {
              const owner = await publicClient.readContract({
                address: nftContractAddress as `0x${string}`,
                abi: FajuARC_ABI,
                functionName: 'ownerOf',
                args: [BigInt(tokenIdStr)],
              }) as string
              if (owner.toLowerCase() === address.toLowerCase()) {
                tokenIds.push(BigInt(tokenIdStr))
              }
            } catch {
              // Token não existe mais ou foi transferido
            }
          }
          console.log('✅ Eventos Transfer retornaram:', tokenIds.map(id => id.toString()))
        } catch (error: any) {
          const errorMsg = error.message || String(error)
          console.warn('⚠️ Busca por eventos falhou:', errorMsg)
          if (errorMsg.includes('limites do RPC') || errorMsg.includes('Timeout')) {
            toast.error('RPC limit reached. Some NFTs may not appear. Please refresh again.')
          }
        }
      }

      // Estratégia 4: Último fallback - iterar totalSupply
      if (tokenIds.length === 0) {
        try {
          const totalSupply = await publicClient.readContract({
            address: nftContractAddress as `0x${string}`,
            abi: FajuARC_ABI,
            functionName: 'totalSupply',
          })
          const totalNum = Number(totalSupply)
          for (let i = 0; i < totalNum; i++) {
            try {
              const owner = await publicClient.readContract({
                address: nftContractAddress as `0x${string}`,
                abi: FajuARC_ABI,
                functionName: 'ownerOf',
                args: [BigInt(i)],
              }) as string
              if (owner.toLowerCase() === address.toLowerCase()) {
                tokenIds.push(BigInt(i))
              }
            } catch {
              // Token não existe, continuar
            }
          }
          console.log('✅ Fallback totalSupply retornou:', tokenIds.map(id => id.toString()))
        } catch (error: any) {
          console.error('❌ Erro no fallback totalSupply:', error)
        }
      }

      // Buscar informações de cada NFT
      const nftInfos = await Promise.all(
        tokenIds.map(async (tokenId) => {
          try {
            const [tokenURI, owner] = await Promise.all([
              publicClient.readContract({
                address: nftContractAddress as `0x${string}`,
                abi: FajuARC_ABI,
                functionName: 'tokenURI',
                args: [tokenId],
              }),
              publicClient.readContract({
                address: nftContractAddress as `0x${string}`,
                abi: FajuARC_ABI,
                functionName: 'ownerOf',
                args: [tokenId],
              }),
            ])

            return {
              tokenId: tokenId.toString(),
              tokenURI: tokenURI as string,
              owner: owner as string,
            }
          } catch (error) {
            console.warn(`Erro ao carregar token ${tokenId}:`, error)
            return null
          }
        })
      )

      const validNFTs = nftInfos.filter((nft): nft is NFTInfo => nft !== null)
      setNfts(validNFTs)
    } catch (error: any) {
      console.error('❌ Erro ao carregar NFTs:', error)
      toast.error(error.message || 'Error loading NFTs')
      setNfts([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (isConnected && address) {
      loadNFTs()
    } else {
      setNfts([])
    }
  }, [isConnected, address, publicClient, nftContractAddress])

  // Auto-abrir modal no mobile quando não conectado (apenas uma vez)
  useEffect(() => {
    if (typeof window === 'undefined') return
    
    const mobile = isMobile()
    const alreadyPrompted = sessionStorage.getItem('myNftsAutoPrompted') === 'true'
    
    // Only auto-open if: mobile, not connected, not already prompted, and ref not set
    if (mobile && !isConnected && !alreadyPrompted && !autoPromptedRef.current) {
      // Small delay to ensure page loaded
      const timer = setTimeout(() => {
        openModal()
        sessionStorage.setItem('myNftsAutoPrompted', 'true')
        autoPromptedRef.current = true
      }, 500)
      
      return () => clearTimeout(timer)
    }
    // Dependencies: only isConnected to avoid re-running when modal state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected])

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      toast.success(`${label} copied!`)
      setTimeout(() => setCopied(null), 2000)
    } catch (err) {
      toast.error('Failed to copy')
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-6xl mx-auto py-12 px-4">
        <div className="bg-slate-900/50 border border-cyan-500/20 rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold mb-4">My NFTs</h2>
          <p className="text-slate-400 mb-6">Connect your wallet to view your NFTs</p>
          <button
            onClick={openModal}
            className="inline-flex items-center gap-2 px-6 py-3 bg-cyan-500 hover:bg-cyan-600 rounded-lg text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Wallet className="w-5 h-5" />
            Connect Wallet
          </button>
        </div>
      </div>
    )
  }

  if (!nftContractAddress) {
    return (
      <div className="max-w-6xl mx-auto py-12 px-4">
        <div className="bg-amber-900/20 border border-amber-500/30 rounded-2xl p-8 text-center">
          <h2 className="text-2xl font-bold mb-4 text-amber-400">Contract not configured</h2>
          <p className="text-slate-400">
            Configure VITE_ARC_COLLECTION_ADDRESS or VITE_GIFT_CARD_NFT_ADDRESS in the .env file
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto py-12 px-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold mb-2">My NFTs</h1>
          <p className="text-slate-400">
            {nfts.length === 0
              ? 'You don\'t have any NFTs yet'
              : `${nfts.length} NFT${nfts.length > 1 ? 's' : ''} found`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowImportInstructions(!showImportInstructions)}
            className="px-4 py-2 bg-cyan-500/10 border border-cyan-500/30 rounded-lg text-cyan-400 hover:bg-cyan-500/20 transition-colors text-sm font-medium flex items-center gap-2"
          >
            <Info className="w-4 h-4" />
            Import to MetaMask
          </button>
          <button
            onClick={loadNFTs}
            disabled={loading}
            className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-white hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {showImportInstructions && (
        <div className="mb-6 bg-cyan-500/10 border border-cyan-500/30 rounded-xl p-6">
          <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <ImageIcon className="w-5 h-5" />
            How to import NFT to MetaMask
          </h3>
          <ol className="space-y-2 text-sm text-slate-300">
            <li>1. Open MetaMask</li>
            <li>2. Go to NFTs → Import NFT</li>
            <li>3. Paste the contract address: <code className="bg-slate-800 px-2 py-1 rounded">{nftContractAddress}</code></li>
            <li>4. Paste the Token ID of the NFT you want to import</li>
          </ol>
          <button
            onClick={() => copyToClipboard(nftContractAddress, 'Contract')}
            className="mt-4 px-4 py-2 bg-cyan-500 hover:bg-cyan-600 rounded-lg text-white text-sm font-medium flex items-center gap-2"
          >
            {copied === 'Contract' ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            Copy Contract Address
          </button>
        </div>
      )}

      {loading && nfts.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-cyan-400" />
        </div>
      ) : nfts.length === 0 ? (
        <div className="bg-slate-900/50 border border-cyan-500/20 rounded-2xl p-12 text-center">
          <p className="text-slate-400 mb-4">You haven't minted any NFTs yet</p>
          <a
            href="/mint"
            className="inline-block px-6 py-3 bg-cyan-500 hover:bg-cyan-600 rounded-lg text-white font-medium transition-colors"
          >
            Mint an NFT
          </a>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {nfts.map((nft) => (
            <NFTCard
              key={nft.tokenId}
              nft={nft}
              contractAddress={nftContractAddress}
              copied={copied}
              onCopy={copyToClipboard}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Componente NFT Card simples (sem criar arquivo extra)
function NFTCard({
  nft,
  contractAddress,
  copied,
  onCopy,
}: {
  nft: NFTInfo
  contractAddress: string
  copied: string | null
  onCopy: (text: string, label: string) => void
}) {
  const [metadata, setMetadata] = useState<NFTMetadata | null>(null)
  const [loadingMeta, setLoadingMeta] = useState(true)

  useEffect(() => {
    async function fetchMetadata() {
      if (!nft.tokenURI) {
        setLoadingMeta(false)
        return
      }

      try {
        const httpUrl = ipfsToHttp(nft.tokenURI)
        const response = await fetch(httpUrl)
        if (response.ok) {
          const data = await response.json()
          setMetadata(data)
        }
      } catch (error) {
        console.error('Erro ao buscar metadata:', error)
      } finally {
        setLoadingMeta(false)
      }
    }

    fetchMetadata()
  }, [nft.tokenURI])

  const imageUrl = metadata?.image ? ipfsToHttp(metadata.image) : null

  return (
    <div className="bg-slate-900/50 border border-cyan-500/20 rounded-xl p-4 hover:border-cyan-500/40 transition-colors">
      {loadingMeta ? (
        <div className="aspect-square bg-slate-800 rounded-lg flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-cyan-400" />
        </div>
      ) : imageUrl ? (
        <div className="aspect-square rounded-lg overflow-hidden mb-4">
          <img
            src={imageUrl}
            alt={metadata?.name || `NFT #${nft.tokenId}`}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
            }}
          />
        </div>
      ) : (
        <div className="aspect-square bg-slate-800 rounded-lg flex items-center justify-center mb-4">
          <ImageIcon className="w-12 h-12 text-slate-600" />
        </div>
      )}

      <div className="space-y-2">
        <h3 className="font-semibold text-lg">
          {metadata?.name || `NFT #${nft.tokenId}`}
        </h3>
        {metadata?.description && (
          <p className="text-sm text-slate-400 line-clamp-2">{metadata.description}</p>
        )}
        <div className="text-xs text-slate-500 font-mono">Token ID: {nft.tokenId}</div>
      </div>

      <div className="mt-4 pt-4 border-t border-slate-700 flex gap-2">
        <button
          onClick={() => onCopy(contractAddress, 'Contract')}
          className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-300 transition-colors flex items-center justify-center gap-1"
        >
          {copied === 'Contract' ? (
            <CheckCircle2 className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
          Contract
        </button>
        <button
          onClick={() => onCopy(nft.tokenId, 'Token ID')}
          className="flex-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs text-slate-300 transition-colors flex items-center justify-center gap-1"
        >
          {copied === 'Token ID' ? (
            <CheckCircle2 className="w-3 h-3 text-green-400" />
          ) : (
            <Copy className="w-3 h-3" />
          )}
          Token ID
        </button>
        <a
          href={`https://testnet.arcscan.app/token/${contractAddress}?a=${nft.tokenId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="px-3 py-2 bg-cyan-500/10 hover:bg-cyan-500/20 rounded-lg text-xs text-cyan-400 transition-colors flex items-center justify-center"
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
    </div>
  )
}

