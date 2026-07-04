import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Lock, ArrowLeft } from 'lucide-react'

export default function Privacy() {
  return (
    <div className="min-h-screen bg-obsidian">
      <div className="border-b border-obsidian-500 bg-obsidian-400 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link to="/" className="text-white/40 hover:text-white"><ArrowLeft size={18} /></Link>
          <div className="flex items-center gap-2"><Lock size={16} className="text-cyan" /><h1 className="font-bold text-sm">Privacy Policy</h1></div>
          <span className="ml-auto text-xs text-white/30">v1.0 · January 1, 2025</span>
        </div>
      </div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-3xl mx-auto px-4 py-10 pb-20 space-y-8">
        <div className="bg-cyan/5 border border-cyan/20 rounded-2xl p-6">
          <p className="text-sm text-white/70 leading-relaxed">This Privacy Policy explains how <strong className="text-white">Campus Plug Technologies Ltd</strong> collects, uses, and protects your personal data. We comply with the Nigeria Data Protection Act (NDPA) 2023. DPO: <strong className="text-cyan">dpo@campusplug.ng</strong></p>
        </div>

        <section>
          <h2 className="text-base font-black mb-3 pb-2 border-b border-obsidian-500">Data We Collect</h2>
          <div className="border border-obsidian-500 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead><tr className="bg-obsidian-300"><th className="text-left px-4 py-2.5 text-white/60 font-bold">Data</th><th className="text-left px-4 py-2.5 text-white/60 font-bold">Purpose</th><th className="text-left px-4 py-2.5 text-white/60 font-bold">Retention</th></tr></thead>
              <tbody className="divide-y divide-obsidian-500">
                {[
                  ['University email', 'Account verification', 'Account lifetime + 2 years'],
                  ['Full name, matric', 'Profile identity', 'Account lifetime'],
                  ['Device fingerprint hash', 'Fraud prevention / device banning', 'Account + 3 years'],
                  ['GPS coordinates (meetups)', 'Proof of Presence during escrow', 'Not stored — status only'],
                  ['Chat messages', 'Transaction communication & dispute evidence', 'Account + 2 years'],
                  ['Message audit logs', 'Dispute evidence (immutable)', 'Permanent'],
                  ['Transaction data', 'Escrow & payment processing', 'Account + 7 years'],
                  ['IP address', 'Security monitoring', '90 days rolling'],
                  ['Terms acceptance log', 'Legal compliance', 'Permanent'],
                ].map(([d, p, r]) => (
                  <tr key={d} className="hover:bg-obsidian-300/30">
                    <td className="px-4 py-2.5 text-white/70 font-medium">{d}</td>
                    <td className="px-4 py-2.5 text-white/50">{p}</td>
                    <td className="px-4 py-2.5 text-white/40">{r}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {[
          { title: 'GPS & Location', body: 'We only collect GPS during active PlugPay meetup sessions via the standard browser Geolocation API. Polling rates: 60s idle, 20s OMW, 5s in-zone. GPS stops immediately on transaction completion, dispute, or component unmount. We do not track you outside meetup sessions. Raw coordinates are not stored permanently. We detect impossible movement speeds (>300km/h) for fraud flagging only.' },
          { title: 'Device Fingerprinting', body: 'We use FingerprintJS (browser signals: screen, fonts, GPU, OS, timezone) to generate a device hash. This is used only for: preventing banned users creating new accounts, detecting multi-account abuse, and verifying known devices. The hash is not shared with advertisers.' },
          { title: 'Chat & Audit Logs', body: 'Messages are locked 60 seconds after sending. Edits and deletions are archived in an immutable audit log accessible only to assigned jury members during active disputes. The full message is only accessible during dispute proceedings.' },
          { title: 'Payment Processing', body: 'Payments are processed by Paystack (CBN-licensed). Campus Plug does not store card numbers, CVVs, or PINs. We receive only: payment reference, status, and amount.' },
          { title: 'Data Sharing', body: 'We do not sell your data. We share only with: Paystack (payment processing), FingerprintJS (device hash only — no personal data), Supabase (infrastructure, EU/US data centres), and law enforcement (valid Nigerian court order only).' },
          { title: 'Your Rights (NDPA 2023)', body: 'You have the right to: access, correct, delete (subject to legal retention), portability, and object to processing. Contact dpo@campusplug.ng. We respond within 30 days. Some data (audit logs, terms acceptance) cannot be deleted as they form immutable legal records.' },
          { title: 'Security', body: 'All data transmitted over HTTPS/TLS 1.3. Row Level Security on every database table. Passwords hashed by Supabase Auth. Passkey private keys never leave your device. HMAC-SHA512 verification on all payment webhooks. Immutable audit logging at database rule level.' },
        ].map(({ title, body }) => (
          <section key={title}>
            <h2 className="text-base font-black mb-3 pb-2 border-b border-obsidian-500">{title}</h2>
            <p className="text-sm text-white/60 leading-relaxed">{body}</p>
          </section>
        ))}

        <div className="border-t border-obsidian-500 pt-6 flex items-center justify-between text-xs text-white/30">
          <span>Campus Plug Technologies Ltd · 2025</span>
          <Link to="/terms" className="text-cyan hover:underline">Terms of Service →</Link>
        </div>
      </motion.div>
    </div>
  )
}
