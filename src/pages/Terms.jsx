import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Shield, ArrowLeft } from 'lucide-react'

export default function Terms() {
  return (
    <div className="min-h-screen bg-obsidian">
      <div className="border-b border-obsidian-500 bg-obsidian-400 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-4">
          <Link to="/" className="text-white/40 hover:text-white transition-colors"><ArrowLeft size={18} /></Link>
          <div className="flex items-center gap-2"><Shield size={16} className="text-cyan" /><h1 className="font-bold text-sm">Terms of Service</h1></div>
          <span className="ml-auto text-xs text-white/30">v1.0 · January 1, 2025</span>
        </div>
      </div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="max-w-3xl mx-auto px-4 py-10 pb-20 space-y-8">
        <div className="bg-cyan/5 border border-cyan/20 rounded-2xl p-6">
          <p className="text-sm text-white/70 leading-relaxed">These Terms govern your use of Campus Plug, operated by <strong className="text-white">Campus Plug Technologies Ltd</strong>. By creating an account you agree to these terms. Effective: <strong className="text-white">January 1, 2025</strong>.</p>
        </div>

        {[
          { title: '1. Eligibility', body: 'Campus Plug is exclusively for currently enrolled Nigerian university students. You must register with a valid .edu.ng or recognised .edu email address. You must be 18 or older (or have parental consent).' },
          { title: '2. Marketplace Rules', body: 'You may not list illegal goods, prescription medications, counterfeit items, weapons, or adult content. Repeat violations result in permanent device-level bans.' },
          { title: '3. PlugPay Escrow', body: 'All transactions above ₦500 go through PlugPay escrow powered by Paystack (CBN-licensed). Funds are held until a verified meetup exchange. The QR handshake or GPS dual-confirmation constitutes proof of exchange. Auto-release occurs 48 hours after a seller requests release if no dispute is filed. Campus Plug is not a bank.' },
          { title: '4. GPS & Location Data', body: 'GPS is collected ONLY during active PlugPay meetup transactions using the Proof of Presence (PoP) system. We poll at 60s idle / 20s OMW / 5s in-zone. GPS stops immediately on transaction release, dispute, or cancellation. Raw coordinates are never permanently stored. We detect GPS spoofing (>300km/h movement) and flag accounts — this is not grounds for automatic suspension.' },
          { title: '5. Device Fingerprinting', body: 'We use FingerprintJS to generate a device hash for fraud prevention. This hash is stored linked to your account and used to prevent banned users from creating new accounts. It is not used for advertising.' },
          { title: '6. Chat & Audit Logs', body: 'Messages are stored linked to your listing and transaction. You may edit or delete within 60 seconds. After 60 seconds messages are immutable. Original content of edits/deletes is preserved in an audit log. Chat history is provided to the Peer Jury if a transaction is disputed. By using chat you consent to messages being used as dispute evidence.' },
          { title: '7. Peer Jury System', body: 'Disputes are resolved by 3–5 anonymous jurors from different campuses. High-value (₦50,000+) cases require 4 votes and a 20-second minimum review. Jury verdicts are final and binding within the platform. Jurors receive ₦100 PlugCredit and +20 PlugScore for correct verdicts.' },
          { title: '8. PlugScore & Tiers', body: 'PlugScore (0–1000) affects your visibility and feature access. It is not a credit score. Changes are governed by DB triggers and jury decisions. Campus Plug does not manually adjust scores except to correct system errors.' },
          { title: '9. User Conduct', body: 'You agree not to: move transactions off-platform, create fake listings, collude to manipulate trending rankings, use bots or automated scripts, or harass other users.' },
          { title: '10. Termination', body: 'Campus Plug may suspend accounts for losing disputes, confirmed GPS spoofing, device fingerprint matching a banned account, or repeated Trust Guard violations. Appeal within 30 days at legal@campusplug.ng.' },
          { title: '11. Liability', body: 'Campus Plug is a technology platform. We are not liable for item quality, user conduct, goods lost during physical exchanges, GPS detection inaccuracies, jury decisions, or financial losses beyond a single escrow amount.' },
          { title: '12. Governing Law', body: 'These Terms are governed by the laws of the Federal Republic of Nigeria. Contact: legal@campusplug.ng' },
        ].map(({ title, body }) => (
          <section key={title}>
            <h2 className="text-base font-black text-white mb-3 pb-2 border-b border-obsidian-500">{title}</h2>
            <p className="text-sm text-white/60 leading-relaxed">{body}</p>
          </section>
        ))}

        <div className="border-t border-obsidian-500 pt-6 flex items-center justify-between text-xs text-white/30">
          <span>Campus Plug Technologies Ltd · 2025</span>
          <Link to="/privacy" className="text-cyan hover:underline">Privacy Policy →</Link>
        </div>
      </motion.div>
    </div>
  )
}
