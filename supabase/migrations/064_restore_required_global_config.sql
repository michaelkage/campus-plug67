-- Restore missing default feature configuration without overwriting administrator choices.
-- Historical defaults are defined in 009_v67_integration.sql; this migration
-- is safe to rerun and only inserts keys that are absent.
INSERT INTO public.global_config (key, mode, threshold_value, label, description, icon)
VALUES
  ('pop_engine',        'HYBRID', 1,  'GPS Meetup (PoP)',      'Proof-of-Presence meetup system',           '📍'),
  ('multi_modal_pop',   'HYBRID', 5,  'Indoor PoP (BLE/SSID)', 'SSID + BLE fallback for Faraday buildings', '📶'),
  ('peer_jury',         'HYBRID', 1,  'Peer Jury',             'Cross-campus dispute resolution',            '⚖️'),
  ('trending_engine',   'MANUAL', 50, 'Trending Engine',       'Demand signals & trending feed',             '🔥'),
  ('trust_signals',     'AUTO',   3,  'Trust Signals',         'Confidence badges & verified patterns',      '🛡️'),
  ('plug_credit',       'MANUAL', 0,  'PlugCredit',            'BNPL backed by PlugScore',                   '💳'),
  ('tier_system',       'AUTO',   0,  'Tier System',           'Citizen / Trusted / Elite progression',      '⭐'),
  ('flash_deals',       'HYBRID', 10, 'Flash Deals',           'Time-limited 2-hour listings',               '⚡'),
  ('referral_system',   'AUTO',   1,  'Referrals',             'Referral codes & bonus system',              '🎁'),
  ('insight_dashboard', 'MANUAL', 0,  'Insight Engine',        'Escrow velocity & behavior analytics',      '📊')
ON CONFLICT (key) DO NOTHING;
