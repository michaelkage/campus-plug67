# Campus Plug — Sovereign Ecosystem v6.8.0 (CP-67 MATRIX)

> The definitive full-stack student marketplace for Nigerian universities.
> React 18 · Vite · Tailwind CSS · Supabase (Full Suite) · Paystack · Framer Motion

---

## Feature Matrix

| Layer | Feature | Implementation |
|---|---|---|
| **Security** | EDU email domain gating | `allowed_domains` table + fallback regex |
| **Security** | Hardware fingerprinting | FingerprintJS → `user_security` table |
| **Security** | Biometric passkey login | WebAuthn API + `@simplewebauthn/browser` |
| **Security** | EXIF forensics | `exifr` + GPS bounding box check + canvas strip |
| **Marketplace** | P2P listings + CRUD | `listings` table with images array |
| **Marketplace** | Predefined SKU Catalog | `global_sku_catalog` + `pg_trgm` fuzzy matching |
| **Marketplace** | "The Beacon" Demand Gen | `buyer_broadcast_demands` + active seller alerts |
| **Payments** | 7-State Escrow Engine | `escrow_transactions` tracking state logic |
| **Payments** | QR handshake release | `qr_secret` UUID → Edge Function auth |
| **Payments** | Auto-release cron | 48h countdown → `pg_cron` & Edge Function |
| **Social** | Study Pools | Atomic `UPDATE ... WHERE current_count < max_capacity` |
| **Social** | Gig marketplace | `gigs` table + real-time pulsing dots |
| **Academic** | Class Alert Hub | `class_alerts` & Note Marketplace integration |
| **Career** | PlugScore | Dynamic 500–1000, DB triggers: +50 sale, +10 EXIF, -100 dispute |
| **Career** | Verified Resume PDF | `jsPDF` with live QR code → `/verify/:id` public route |
| **Passkeys** | Registration & Auth | Challenge → biometric → signature verify → session token |
| **UI/UX** | Page transitions | Framer Motion `AnimatePresence` + spring |
| **UI/UX** | Real-time activity feed | Supabase Realtime subscription, prepend-on-insert |
| **Perf** | Edge AI Proxy | Semantic chat interceptor via `@google/genai` |
| **PWA** | Offline support | Workbox network-first for API, cache-first for images |

---

## Architecture

```text
campus-plug/
├── src/
│   ├── App.tsx                          # Core Router, AnimatePresence
│   ├── index.css                        # Tailwind + custom CSS
│   ├── main.tsx                         # React DOM entry
│   ├── lib/
│   │   ├── supabase.ts                  # Client, edge wrappers, formatting
│   │   ├── security.js                  # Device hash, EXIF analysis
│   │   ├── passkeys.js                  # WebAuthn workflows
│   │   └── ai.ts                        # Gemini Proxy interface
│   ├── components/
│   │   ├── marketplace/                 # MultiMatchSelectionGrid, etc.
│   │   ├── ui/                          # DemandEngine, NotificationBanner, etc.
│   │   ├── escrow/                      # PlugHubTerminal
│   │   └── academic/                    # ClassDetailAlertHub
│   └── pages/                           # Home, Marketplace, StudyPools, WarRoom
├── supabase/
│   ├── migrations/                      # 010_v68_campus_overhaul.sql (CP-67 MATRIX)
│   └── functions/                       # ai-proxy, beacon-matcher, paystack-webhook
├── .github/workflows/                   # Automated GH actions
└── tailwind.config.js                   # Obsidian/Cyan/Purple theme
```

---

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo>
cd campus-plug
npm install

# 2. Environment
cp .env.example .env
# Edit .env — fill in Supabase URL, anon key, Paystack public key

# 3. Database
# Run all migrations located in supabase/migrations/
supabase db push

# 4. Edge Function Deployments
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy --all

# 5. Run Local Server
npm run dev
```

---

## PlugScore System

Points are managed by PostgreSQL triggers to ensure structural integrity:

| Event | Delta | Trigger |
|---|---|---|
| Completed sale | +50 | `handle_transaction_update` on `released` |
| EXIF-verified upload | +10 | `update_plugscore_on_event` |
| 5★ review received | +25 | `ratings` insert trigger |
| Lost dispute | -100 | `apply_dispute_penalty()` |

Score range: 0–1000, starting at 500 on signup.

---

## Production Checklist

- [ ] Switch Paystack to live keys (`pk_live_` / `sk_live_`)
- [ ] Set `RP_ID` = your actual domain (e.g. `campusplug.ng`)
- [ ] Set `APP_ORIGIN` = `https://campusplug.ng`
- [ ] Deploy Edge Functions with `supabase functions deploy --all`
- [ ] Add GitHub repo secrets for Actions
- [ ] Enable Supabase Point-in-Time Recovery
- [ ] Verify `pg_cron` routines for Anti-Ghosting features
- [ ] Test full escrow flow with Paystack test card on staging

---

## Terms and Conditions

By deploying, interacting with, or registering on Campus Plug, users and administrators agree to the following conditions:

1. **Escrow Liability**: Campus Plug provides a 7-state escrow framework for peer-to-peer transactions. The platform acts strictly as a neutral software custodian. We are not legally liable for damaged, stolen, or misrepresented physical goods exchanged during physical meetups.
2. **Device Fingerprinting & Banning**: The platform actively fingerprints hardware (`visitorId`) to prevent fraud. By using the platform, you consent to hardware tracking for security purposes. Administrators reserve the right to permanently ban devices found violating our trust signals.
3. **Academic Integrity**: The Note Marketplace and Study Pools are for supplemental academic use. Uploading copyright-infringing exam materials or restricted intellectual property is strictly prohibited and will result in account termination.
4. **Dispute Resolution**: Any disputes initiated inside the PlugHub Terminal will freeze funds. Users agree to abide by the final arbitration decision provided by the platform administrators or automated dispute algorithms.
5. **Data Privacy**: Profile details, location beacons, and chat records are stored securely, but we maintain the right to intercept and scan chats (via the AI proxy) strictly to prevent off-platform scam attempts or prohibited activities.

*These terms are subject to change. Ensure you consult with a legal professional before launching commercially.*
