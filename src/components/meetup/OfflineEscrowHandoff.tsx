import { useCallback, useEffect, useRef, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { AlertTriangle, Camera, CheckCircle2, CloudOff, RefreshCw, ShieldCheck, X } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  createOfflineReceipt,
  issueOfflineVoucher,
  loadOfflineVoucher,
  makeRotatingOfflineQr,
  refreshOfflineEscrowPublicKey,
  saveOfflineEscrowReceipt,
  syncPendingOfflineEscrowReceipts,
  syncOfflineEscrowReceipt,
  type IssuedOfflineVoucher,
} from '@/lib/offlineEscrow'

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>
}
type Props = {
  transactionId: string
  userId: string
  role: 'buyer' | 'seller'
  releaseUnlocked: boolean
  onReconciled?: () => void
}

function formatExpiry(value: string) {
  const remaining = Math.max(0, Date.parse(value) - Date.now())
  const minutes = Math.floor(remaining / 60_000)
  const seconds = Math.floor((remaining % 60_000) / 1000)
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`
}

export default function OfflineEscrowHandoff({
  transactionId,
  userId,
  role,
  releaseUnlocked,
  onReconciled,
}: Props) {
  const [online, setOnline] = useState(() => navigator.onLine)
  const onReconciledRef = useRef(onReconciled)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [voucher, setVoucher] = useState<IssuedOfflineVoucher | null>(null)
  const [qrValue, setQrValue] = useState('')
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [pendingQr, setPendingQr] = useState('')
  const [manualQr, setManualQr] = useState('')
  const [receiptPending, setReceiptPending] = useState(false)
  const [lastMessage, setLastMessage] = useState('')

  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    setScanning(false)
  }, [])

  useEffect(() => {
    onReconciledRef.current = onReconciled
  }, [onReconciled])

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach(track => track.stop())
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (role !== 'buyer') return
    let cancelled = false
    void loadOfflineVoucher(transactionId, userId).then(value => {
      if (!cancelled && value) setVoucher(value)
    })
    return () => { cancelled = true }
  }, [role, transactionId, userId])

  useEffect(() => {
    if (!online) return
    let cancelled = false
    void refreshOfflineEscrowPublicKey().catch(() => undefined)
    void syncPendingOfflineEscrowReceipts(userId).then(results => {
      if (cancelled) return
      const completed = results.filter(result => result.success).length
      if (completed) {
        setReceiptPending(false)
        setLastMessage('Offline receipt synchronized. The two-hour inspection window has started.')
        onReconciledRef.current?.()
      }
    })
    return () => { cancelled = true }
  }, [online, userId])

  useEffect(() => {
    if (!voucher) {
      setQrValue('')
      return
    }
    let cancelled = false
    void makeRotatingOfflineQr(voucher, now).then(value => {
      if (!cancelled) setQrValue(value)
    }).catch(() => {
      if (!cancelled) setQrValue('')
    })
    return () => { cancelled = true }
  }, [voucher, now])

  const prepareVoucher = async () => {
    if (!releaseUnlocked) {
      toast.error('Both Safe Swap check-ins must be fresh and in the same zone before preparing the voucher.')
      return
    }
    setBusy(true)
    try {
      const value = await issueOfflineVoucher(transactionId, userId)
      setVoucher(value)
      setLastMessage('Signed voucher ready. Keep this screen open during the handoff.')
      toast.success('Offline handoff voucher prepared')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to prepare offline voucher')
    } finally {
      setBusy(false)
    }
  }

  const startScan = async () => {
    const BarcodeDetectorCtor = (window as unknown as {
      BarcodeDetector?: new (options?: { formats: string[] }) => BarcodeDetectorLike
    }).BarcodeDetector
    if (!BarcodeDetectorCtor) {
      toast.error('Camera QR scanning is not supported. Paste the rotating QR text below instead.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      })
      streamRef.current = stream
      setScanning(true)
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const video = videoRef.current
      if (!video) throw new Error('Camera preview is unavailable')
      video.srcObject = stream
      await video.play()
      const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] })
      let stopped = false
      const loop = async () => {
        if (stopped) return
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
          requestAnimationFrame(loop)
          return
        }
        try {
          const hit = (await detector.detect(video))[0]?.rawValue
          if (hit) {
            stopped = true
            stopScan()
            setPendingQr(hit)
            return
          }
        } catch {
          // Keep scanning; transient camera frames may not decode.
        }
        if (!stopped) requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
    } catch (error) {
      stopScan()
      toast.error(error instanceof Error ? error.message : 'Unable to start QR camera')
    }
  }

  const confirmScannedVoucher = async () => {
    if (!pendingQr.trim()) return
    setBusy(true)
    try {
      // This click is intentional: WebAuthn requires a fresh user gesture.
      const stored = await createOfflineReceipt(pendingQr.trim(), userId)
      await saveOfflineEscrowReceipt(userId, stored)
      setReceiptPending(true)
      setPendingQr('')
      setManualQr('')
      setLastMessage('Passkey-signed receipt saved on this phone. Funds are still locked until a server sync succeeds.')
      if (navigator.onLine) {
        try {
          const result = await syncOfflineEscrowReceipt(stored)
          setReceiptPending(false)
          setLastMessage(result?.message || 'Receipt synchronized. The two-hour inspection window has started.')
          onReconciledRef.current?.()
          toast.success('Handoff verified. Funds remain protected for two hours.')
        } catch {
          toast.success('Receipt saved securely. It will sync when the connection returns.')
        }
      } else {
        toast.success('Offline receipt saved. No payout has been made.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Passkey receipt verification failed')
    } finally {
      setBusy(false)
    }
  }

  const voucherExpired = voucher ? Date.parse(voucher.claims.expires_at) <= now : false
  const syncGraceOpen = voucher ? Date.parse(voucher.claims.sync_grace_until) > now : false

  if (role === 'buyer') {
    return (
      <section className="rounded-md border border-primary/30 bg-surface-container p-5 space-y-4" aria-label="Offline escrow voucher">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary-container p-2 text-on-primary-container"><ShieldCheck size={20}/></div>
          <div className="min-w-0 flex-1">
            <h2 className="font-black text-sm">Offline handoff voucher</h2>
            <p className="text-xs text-on-surface-variant mt-1">Prepare this while connected, then let the seller scan the rotating QR. The voucher authorizes a provisional handoff, not an offline payout.</p>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-wider text-primary">{online ? 'Online' : 'Offline'}</span>
        </div>
        {voucher && !voucherExpired && qrValue ? (
          <div className="rounded-md border border-outline-variant bg-white p-4 space-y-3">
            <div className="flex justify-center"><QRCodeSVG value={qrValue} size={240} level="M" includeMargin/></div>
            <div className="text-center text-xs font-bold text-slate-900">Show this rotating code to the seller</div>
            <div className="text-center text-[11px] text-slate-600">Voucher expires in {formatExpiry(voucher.claims.expires_at)}</div>
            <div className="text-center text-[10px] text-slate-500">Refreshes every 30 seconds · one-time use</div>
          </div>
        ) : voucher && voucherExpired ? (
          <div className="rounded-md border border-outline-variant bg-surface-container-high p-4 text-sm">
            <div className="font-bold">Voucher expired</div>
            <p className="text-xs text-on-surface-variant mt-1">
              {syncGraceOpen
                ? `A seller receipt can still synchronize until ${new Date(voucher.claims.sync_grace_until).toLocaleTimeString()}.`
                : 'The previous sync window has closed. You can prepare a fresh voucher.'}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-outline-variant bg-surface-container-high p-4 text-center">
            <CloudOff size={24} className="mx-auto text-primary mb-2"/>
            <p className="text-xs text-on-surface-variant">A voucher is created online after both parties have fresh Safe Swap check-ins. It remains verifiable when the network drops.</p>
          </div>
        )}
        {!voucher && (
          <button onClick={() => void prepareVoucher()} disabled={busy || !online || !releaseUnlocked} className="w-full rounded-md bg-primary px-4 py-3 text-sm font-black text-on-primary disabled:opacity-40">
            {busy ? 'Preparing signed voucher…' : !online ? 'Connect to prepare voucher' : !releaseUnlocked ? 'Waiting for both Safe Swap check-ins' : 'Prepare offline handoff QR'}
          </button>
        )}
        {voucher && voucherExpired && !syncGraceOpen && (
          <button onClick={() => void prepareVoucher()} disabled={busy || !online || !releaseUnlocked} className="w-full rounded-md bg-primary px-4 py-3 text-sm font-black text-on-primary disabled:opacity-40">
            {busy ? 'Preparing…' : 'Prepare a new voucher'}
          </button>
        )}
        <div className="rounded-md bg-surface-container-high p-3 text-[11px] text-on-surface-variant">
          Funds remain in escrow. The two-hour inspection period starts only after the seller's passkey-signed receipt reaches the server.
        </div>
        {lastMessage && <p className="text-xs text-primary">{lastMessage}</p>}
      </section>
    )
  }

  return (
    <section className="rounded-md border border-outline-variant bg-surface-container p-5 space-y-4" aria-label="Offline escrow receipt scanner">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-secondary-container p-2 text-on-secondary-container"><Camera size={20}/></div>
        <div className="min-w-0 flex-1">
          <h2 className="font-black text-sm">Scan buyer's offline handoff QR</h2>
          <p className="text-xs text-on-surface-variant mt-1">Your phone verifies the Campus Plug signature locally. A passkey then signs the receipt, which stays provisional until it synchronizes.</p>
        </div>
        <span className="text-[10px] font-bold uppercase tracking-wider text-primary">{online ? 'Online' : 'Offline'}</span>
      </div>
      {scanning ? (
        <div className="rounded-md overflow-hidden border border-outline-variant bg-black">
          <video ref={videoRef} playsInline muted className="w-full aspect-square object-cover"/>
          <button onClick={stopScan} className="w-full py-3 border-t border-white/20 text-white text-sm font-bold flex items-center justify-center gap-2"><X size={16}/>Stop scanner</button>
        </div>
      ) : (
        <button onClick={() => void startScan()} disabled={busy} className="w-full rounded-md bg-primary px-4 py-3 text-sm font-black text-on-primary disabled:opacity-40">
          <span className="inline-flex items-center justify-center gap-2"><Camera size={16}/>Open QR scanner</span>
        </button>
      )}
      <div className="space-y-2">
        <label htmlFor="offline-handoff-qr" className="text-xs font-bold">Camera unavailable? Paste the rotating QR text</label>
        <textarea id="offline-handoff-qr" rows={3} value={manualQr} onChange={event => setManualQr(event.target.value)} disabled={busy} placeholder="CPQ1.CPV1.…" className="input w-full font-mono text-[10px]"/>
        <button onClick={() => setPendingQr(manualQr.trim())} disabled={busy || !manualQr.trim()} className="w-full rounded-md border border-outline-variant py-2 text-xs font-bold disabled:opacity-40">Check pasted QR</button>
      </div>
      {pendingQr && (
        <div className="rounded-md border border-primary/30 bg-primary-container/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-sm font-bold"><AlertTriangle size={16}/>Confirm the scanned voucher</div>
          <p className="text-xs text-on-surface-variant">The next step requests your device passkey. This records a provisional handoff only.</p>
          <button onClick={() => void confirmScannedVoucher()} disabled={busy} className="w-full rounded-md bg-primary py-3 text-sm font-black text-on-primary disabled:opacity-40">
            {busy ? 'Verifying passkey…' : 'Verify voucher and sign receipt'}
          </button>
        </div>
      )}
      {receiptPending && (
        <div className="rounded-md border border-tertiary/30 bg-tertiary/10 p-3 text-xs">
          <div className="flex items-center gap-2 font-bold"><CloudOff size={15}/>Receipt saved on this phone</div>
          <p className="mt-1 text-on-surface-variant">No money has been paid out. The receipt will synchronize when this device is online.</p>
          {online && <button onClick={() => void syncPendingOfflineEscrowReceipts(userId).then(results => { if (results.some(result => result.success)) { setReceiptPending(false); setLastMessage('Receipt synchronized. Inspection window started.'); onReconciledRef.current?.() } })} className="mt-2 inline-flex items-center gap-2 text-primary font-bold"><RefreshCw size={13}/>Retry sync</button>}
        </div>
      )}
      {lastMessage && <p className="text-xs text-primary">{lastMessage}</p>}
      {!online && <p className="text-[11px] text-on-surface-variant">Offline mode: local signature verification and receipt storage work without internet. Server settlement does not.</p>}
      <div className="flex items-center gap-2 text-[10px] text-on-surface-variant"><CheckCircle2 size={13}/>Seller passkey required · one-time server reconciliation</div>
    </section>
  )
}
