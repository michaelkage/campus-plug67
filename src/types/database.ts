// Campus Plug v6.8.0 — Database Type Definitions
// Covers all 40+ production tables.
//
// FIX #1: Json — proper recursive union type (replaces the broken
//         `interface Json extends String, Number, Boolean, {}, null` declaration).
//
// FIX #2: Circular aliases — `Insert` / `Update` no longer reference downstream
//         type aliases (Gig, Notification, …).  They now inline `Row` directly
//         via `Database['public']['Tables'][table]['Row']`, so the `Database`
//         type is fully self-contained and compiles cleanly under
//         `isolatedModules: true`.  The named aliases at the bottom of the file
//         are kept as pure re-exports for consumer convenience.

// ── Primitive JSON type ───────────────────────────────────────────────────────
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[]

// ── Database schema ───────────────────────────────────────────────────────────
export type Database = {
  public: {
    Tables: {

      // ── gigs ────────────────────────────────────────────────────────────────
      gigs: {
        Row: {
          id: string
          title: string
          description: string
          category: string
          price: number
          seller_id: string
          status: 'active' | 'completed' | 'cancelled'
          created_at: string
          updated_at: string
          location_lat?: number | null
          location_long?: number | null
          campus_zone?: string | null
        }
        Insert: Omit<Database['public']['Tables']['gigs']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['gigs']['Row']>
      }

      // ── notifications ────────────────────────────────────────────────────────
      notifications: {
        Row: {
          id: string
          user_id: string
          type: string
          title: string
          message: string
          read: boolean
          created_at: string
          metadata?: Json | null
        }
        Insert: Omit<Database['public']['Tables']['notifications']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['notifications']['Row']>
      }

      // ── activity_feed ────────────────────────────────────────────────────────
      activity_feed: {
        Row: {
          id: string
          user_id?: string | null
          actor_id?: string | null
          actor_name?: string | null
          activity_type?: string | null
          action?: string | null
          entity_id?: string | null
          entity_type?: string | null
          subject?: string | null
          amount?: number | null
          emoji?: string | null
          university?: string | null
          metadata?: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['activity_feed']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['activity_feed']['Row']>
      }

      // ── messages ─────────────────────────────────────────────────────────────
      messages: {
        Row: {
          id: string
          sender_id: string
          receiver_id: string
          transaction_id?: string | null
          listing_id?: string | null
          content?: string | null
          body?: string | null
          read: boolean
          created_at: string
          message_type?: 'text' | 'image' | 'location' | null
          flagged?: boolean | null
          flag_type?: string | null
          is_system_msg?: boolean | null
          deleted_at?: string | null
        }
        Insert: Omit<Database['public']['Tables']['messages']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['messages']['Row']>
      }

      // ── lost_found ───────────────────────────────────────────────────────────
      lost_found: {
        Row: {
          id: string
          title: string
          description: string
          item_type: 'lost' | 'found'
          category: string
          user_id: string
          status: 'active' | 'resolved' | 'closed'
          location_lat?: number | null
          location_long?: number | null
          campus_area?: string | null
          created_at: string
          image_url?: string | null
        }
        Insert: Omit<Database['public']['Tables']['lost_found']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['lost_found']['Row']>
      }

      // ── allowed_domains ──────────────────────────────────────────────────────
      // NOTE: column is `institution_name`, NOT `university`.
      // supabase.ts validateEduEmail must query `institution_name`.
      allowed_domains: {
        Row: {
          id: string
          domain: string
          institution_name: string
          university?: string | null   // alias populated by trigger for legacy queries
          active: boolean
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['allowed_domains']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['allowed_domains']['Row']>
      }

      // ── study_pools ──────────────────────────────────────────────────────────
      study_pools: {
        Row: {
          id: string
          title: string
          subject: string
          max_participants?: number | null
          max_capacity?: number | null          // alias used in join-pool fn
          current_participants?: number | null
          current_count?: number | null         // alias used in join-pool fn
          creator_id?: string | null
          organizer_id?: string | null          // alias used in join-pool fn
          status: 'recruiting' | 'full' | 'active' | 'completed' | 'open' | 'locked'
          location_lat?: number | null
          location_long?: number | null
          scheduled_time?: string | null
          expires_at?: string | null
          unit_price?: number | null
          university?: string | null
          participants?: string[] | null
          payment_refs?: string[] | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['study_pools']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['study_pools']['Row']>
      }

      // ── ratings ──────────────────────────────────────────────────────────────
      ratings: {
        Row: {
          id: string
          user_id: string
          rating: number
          comment?: string | null
          reviewer_id: string
          entity_type: 'user' | 'gig' | 'transaction'
          entity_id: string
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['ratings']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['ratings']['Row']>
      }

      // ── scheduled_jobs ───────────────────────────────────────────────────────
      scheduled_jobs: {
        Row: {
          id: string
          user_id: string
          job_type: string
          scheduled_time: string
          status: 'pending' | 'completed' | 'failed'
          metadata?: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['scheduled_jobs']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['scheduled_jobs']['Row']>
      }

      // ── profile_ratings ──────────────────────────────────────────────────────
      profile_ratings: {
        Row: {
          id: string
          profile_id: string
          overall_rating: number
          total_reviews: number
          reliability_score: number
          response_time_score: number
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['profile_ratings']['Row'], 'id' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['profile_ratings']['Row']>
      }

      // ── gig_bookings ─────────────────────────────────────────────────────────
      gig_bookings: {
        Row: {
          id: string
          gig_id: string
          buyer_id: string
          status: 'pending' | 'confirmed' | 'completed' | 'cancelled'
          scheduled_date?: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['gig_bookings']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['gig_bookings']['Row']>
      }

      // ── listing_views ────────────────────────────────────────────────────────
      listing_views: {
        Row: {
          id: string
          user_id: string
          viewer_id?: string | null             // used by calculate-trending
          listing_id: string
          viewed_at: string
          view_count: number
        }
        Insert: Omit<Database['public']['Tables']['listing_views']['Row'], 'id' | 'viewed_at' | 'view_count'>
        Update: Partial<Database['public']['Tables']['listing_views']['Row']>
      }

      // ── chat_flag_log ────────────────────────────────────────────────────────
      chat_flag_log: {
        Row: {
          id: string
          message_id?: string | null
          sender_id: string
          receiver_id?: string | null
          listing_id?: string | null
          message_hash?: string | null
          flag_type: string
          confidence?: number | null
          severity: 'low' | 'medium' | 'high' | 'critical'
          status?: 'pending_review' | 'resolved' | 'dismissed' | null
          matched_patterns?: string | null
          action_taken?: string | null
          metadata?: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['chat_flag_log']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['chat_flag_log']['Row']>
      }

      // ── trending_listings ────────────────────────────────────────────────────
      trending_listings: {
        Row: {
          id: string
          listing_id: string
          score: number
          views_1h?: number | null
          views_24h?: number | null
          messages_1h?: number | null
          period?: 'daily' | 'weekly' | 'monthly' | null
          calculated_at?: string | null
          updated_at?: string | null
        }
        Insert: Omit<Database['public']['Tables']['trending_listings']['Row'], 'id'>
        Update: Partial<Database['public']['Tables']['trending_listings']['Row']>
      }

      // ── listings ─────────────────────────────────────────────────────────────
      listings: {
        Row: {
          id: string
          title: string
          description: string
          price: number
          category: string
          condition: string
          seller_id: string
          status: 'active' | 'sold' | 'removed' | 'pending'
          images: string[]
          location_lat?: number | null
          location_long?: number | null
          campus_zone?: string | null
          university?: string | null
          created_at: string
          updated_at: string
          view_count?: number | null
          featured?: boolean | null
          is_trending?: boolean | null
          exif_flagged?: boolean | null
        }
        Insert: Omit<Database['public']['Tables']['listings']['Row'], 'id' | 'created_at' | 'updated_at' | 'view_count'>
        Update: Partial<Database['public']['Tables']['listings']['Row']>
      }

      // ── ticker_events ────────────────────────────────────────────────────────
      ticker_events: {
        Row: {
          id: string
          user_id?: string | null
          event_type: string
          transaction_id?: string | null
          latitude?: number | null
          longitude?: number | null
          university?: string | null
          emoji?: string | null
          text?: string | null
          category?: string | null
          metadata?: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['ticker_events']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['ticker_events']['Row']>
      }

      // ── transactions ─────────────────────────────────────────────────────────
      transactions: {
        Row: {
          id: string
          buyer_id: string
          seller_id: string
          listing_id?: string | null
          amount: number
          status:
            | 'pending'
            | 'locked'
            | 'completed'
            | 'cancelled'
            | 'disputed'
            | 'released'
            | 'release_requested'
            | 'meetup_initiated'
          escrow_status: 'pending' | 'held' | 'released' | 'refunded'
          release_code?: string | null
          meetup_latitude?: number | null
          meetup_longitude?: number | null
          meetup_time?: string | null
          buyer_arrived?: boolean | null
          seller_arrived?: boolean | null
          buyer_arrival_time?: string | null
          seller_arrival_time?: string | null
          paystack_ref?: string | null
          payment_verified?: boolean | null
          disputed_at?: string | null
          dispute_reason?: string | null
          created_at: string
          updated_at: string
          completed_at?: string | null
          cancelled_at?: string | null
          released_at?: string | null
          locked_at?: string | null
          payment_method?: string | null
          metadata?: Json | null
        }
        Insert: Omit<Database['public']['Tables']['transactions']['Row'], 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['transactions']['Row']>
      }

      // ── listing_exif_flags ───────────────────────────────────────────────────
      listing_exif_flags: {
        Row: {
          id: string
          listing_id: string
          image_url?: string | null
          flag_type?: string | null
          description?: string | null
          severity: 'low' | 'medium' | 'high'
          gps_lat?: number | null
          gps_lng?: number | null
          gps_mismatch?: boolean | null
          timestamp_flag?: boolean | null
          make?: string | null
          model?: string | null
          software?: string | null
          raw_exif?: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['listing_exif_flags']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['listing_exif_flags']['Row']>
      }

      // ── price_floor_log ──────────────────────────────────────────────────────
      price_floor_log: {
        Row: {
          id: string
          category: string
          min_price: number
          max_price: number
          set_by: string
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['price_floor_log']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['price_floor_log']['Row']>
      }

      // ── streaks ──────────────────────────────────────────────────────────────
      streaks: {
        Row: {
          id: string
          user_id: string
          current_streak: number
          longest_streak: number
          last_activity: string
          streak_type: string
        }
        Insert: Omit<Database['public']['Tables']['streaks']['Row'], 'id'>
        Update: Partial<Database['public']['Tables']['streaks']['Row']>
      }

      // ── user_security ────────────────────────────────────────────────────────
      // Dual-purpose: security flags AND device registration records.
      user_security: {
        Row: {
          id: string
          user_id: string
          flag_type?: string | null
          severity?: 'low' | 'medium' | 'high' | 'critical' | null
          description?: string | null
          status?: 'active' | 'resolved' | 'dismissed' | null
          // Device registration fields (used by security.js registerDevice)
          device_hash?: string | null
          device_label?: string | null
          last_seen_at?: string | null
          trusted?: boolean | null
          metadata?: Json | null
          created_at: string
          resolved_at?: string | null
        }
        Insert: Omit<Database['public']['Tables']['user_security']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['user_security']['Row']>
      }

      // ── banned_devices ───────────────────────────────────────────────────────
      // NOTE: canonical column is `device_fingerprint`.
      // security.js queries must use `device_fingerprint`, NOT `device_hash`.
      banned_devices: {
        Row: {
          id: string
          device_fingerprint: string
          device_hash?: string | null   // legacy alias — prefer device_fingerprint
          user_id?: string | null
          ban_reason: string
          reason?: string | null        // alias for ban_reason used in some queries
          banned_at: string
          banned_until?: string | null
        }
        Insert: Omit<Database['public']['Tables']['banned_devices']['Row'], 'id' | 'banned_at'>
        Update: Partial<Database['public']['Tables']['banned_devices']['Row']>
      }

      // ── passkey_credentials ──────────────────────────────────────────────────
      passkey_credentials: {
        Row: {
          id: string
          user_id: string
          credential_id: string
          public_key: string
          counter?: number | null
          sign_count?: number | null    // alias used by passkey-auth edge fn
          transports: string[]
          device_label?: string | null
          backed_up?: boolean | null
          last_used_at?: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['passkey_credentials']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['passkey_credentials']['Row']>
      }

      // ── emergency_sale_tokens ────────────────────────────────────────────────
      emergency_sale_tokens: {
        Row: {
          id: string
          user_id: string
          token?: string | null
          listing_id?: string | null
          month_year?: string | null
          expires_at?: string | null
          used: boolean
          used_at?: string | null
          used_for?: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['emergency_sale_tokens']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['emergency_sale_tokens']['Row']>
      }

      // ── public_profile_stats ─────────────────────────────────────────────────
      public_profile_stats: {
        Row: {
          id: string
          user_id: string
          total_listings: number
          total_sales: number
          total_purchases: number
          response_rate: number
          avg_response_time: number
          reputation_score: number
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['public_profile_stats']['Row'], 'id' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['public_profile_stats']['Row']>
      }

      // ── safe_zones ───────────────────────────────────────────────────────────
      safe_zones: {
        Row: {
          id: string
          campus_id: string
          zone_name: string
          latitude: number
          longitude: number
          radius_meters: number
          zone_type: 'library' | 'cafeteria' | 'security' | 'admin'
          active: boolean
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['safe_zones']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['safe_zones']['Row']>
      }

      // ── referral_events ──────────────────────────────────────────────────────
      referral_events: {
        Row: {
          id: string
          referrer_id: string
          referee_id: string
          status: 'pending' | 'completed' | 'failed'
          reward_amount: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['referral_events']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['referral_events']['Row']>
      }

      // ── profiles ─────────────────────────────────────────────────────────────
      profiles: {
        Row: {
          id: string
          email: string
          full_name: string
          username: string
          avatar_url?: string | null
          bio?: string | null
          campus_domain: string
          university?: string | null
          balance: number
          plug_score?: number | null
          plug_credit_balance?: number | null
          tier?: 'citizen' | 'trusted' | 'elite' | null
          phone_verified: boolean
          email_verified: boolean
          is_banned: boolean
          juror_enabled?: boolean | null
          juror_cases_today?: number | null
          juror_last_case_at?: string | null
          rolling_accuracy?: number | null
          collusion_flag?: boolean | null
          collusion_ceiling?: number | null
          collusion_flagged_at?: string | null
          gps_spoof_flags?: number | null
          total_sales?: number | null
          created_at: string
          updated_at: string
          last_login?: string | null
        }
        Insert: Omit<Database['public']['Tables']['profiles']['Row'], 'id' | 'created_at' | 'updated_at' | 'balance'>
        Update: Partial<Database['public']['Tables']['profiles']['Row']>
      }

      // ── audit_logs ───────────────────────────────────────────────────────────
      audit_logs: {
        Row: {
          id: string
          user_id: string
          action: string
          entity_type: string
          entity_id?: string | null
          metadata?: Json | null
          ip_address?: string | null
          user_agent?: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['audit_logs']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['audit_logs']['Row']>
      }

      // ── jury_cases ───────────────────────────────────────────────────────────
      // Extended with all fields used by process-dispute v6.7.
      jury_cases: {
        Row: {
          id: string
          transaction_id: string
          plaintiff_id?: string | null
          defendant_id?: string | null
          claimant_id?: string | null
          respondent_id?: string | null
          status:
            | 'pending'
            | 'in_progress'
            | 'deliberating'
            | 'decided'
            | 'resolved'
            | 'appealed'
            | 'escalated'
          description?: string | null
          dispute_reason?: string | null
          evidence_urls?: string[] | null
          evidence_messages?: Json | null
          amount?: number | null
          high_value?: boolean | null
          required_votes?: number | null
          votes_cast?: number | null
          verdict?: string | null
          verdict_decided_at?: string | null
          jurors_assigned?: string[] | null
          juror_rotation_count?: number | null
          juror_campus_lock?: boolean | null
          dispute_campus?: string | null
          escalated_to_admin?: boolean | null
          escalated_at?: string | null
          assigned_at?: string | null
          created_at: string
          resolved_at?: string | null
        }
        Insert: Omit<Database['public']['Tables']['jury_cases']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['jury_cases']['Row']>
      }

      // ── jury_votes ───────────────────────────────────────────────────────────
      jury_votes: {
        Row: {
          id: string
          jury_case_id?: string | null
          case_id?: string | null         // alias used by process-dispute fn
          juror_id: string
          vote?: 'plaintiff' | 'defendant' | null
          verdict?: 'claimant' | 'respondent' | 'split' | 'pending' | null
          reasoning?: string | null
          first_opened_at?: string | null
          opened_count?: number | null
          reward_given?: boolean | null
          plug_credit_payout?: number | null
          payout_processed?: boolean | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['jury_votes']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['jury_votes']['Row']>
      }

      // ── buddy_links ──────────────────────────────────────────────────────────
      buddy_links: {
        Row: {
          id: string
          user_id: string
          buddy_id: string
          status: 'pending' | 'active' | 'blocked'
          trust_score: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['buddy_links']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['buddy_links']['Row']>
      }

      // ── amber_confirmations ──────────────────────────────────────────────────
      amber_confirmations: {
        Row: {
          id: string
          user_id: string
          transaction_id: string
          confirmation_type: 'meetup_arrival' | 'item_received' | 'payment_confirmed'
          latitude?: number | null
          longitude?: number | null
          timestamp: string
          verified: boolean
        }
        Insert: Omit<Database['public']['Tables']['amber_confirmations']['Row'], 'id' | 'timestamp'>
        Update: Partial<Database['public']['Tables']['amber_confirmations']['Row']>
      }

      // ── priority_relist_log ──────────────────────────────────────────────────
      priority_relist_log: {
        Row: {
          id: string
          listing_id: string
          user_id: string
          priority_level: number
          reason: string
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['priority_relist_log']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['priority_relist_log']['Row']>
      }

      // ── juror_reclaims ───────────────────────────────────────────────────────
      juror_reclaims: {
        Row: {
          id: string
          juror_id: string
          jury_case_id: string
          amount: number
          status: 'pending' | 'approved' | 'denied'
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['juror_reclaims']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['juror_reclaims']['Row']>
      }

      // ── plug_credit_ledger ───────────────────────────────────────────────────
      plug_credit_ledger: {
        Row: {
          id: string
          user_id: string
          amount: number
          reason: string
          reference_id?: string | null
          balance_after: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['plug_credit_ledger']['Row'], 'id' | 'balance_after' | 'created_at'>
        Update: Partial<Database['public']['Tables']['plug_credit_ledger']['Row']>
      }

      // ── global_config ────────────────────────────────────────────────────────
      // Column is `value: string`, NOT `is_enabled`.
      // FeatureFlagContext must parse truthy strings from `value`.
      global_config: {
        Row: {
          id: string
          key: string
          value: string
          description?: string | null
          updated_at: string
        }
        Insert: Omit<Database['public']['Tables']['global_config']['Row'], 'id' | 'updated_at'>
        Update: Partial<Database['public']['Tables']['global_config']['Row']>
      }

      // ── chat_scan_logs ───────────────────────────────────────────────────────
      chat_scan_logs: {
        Row: {
          id: string
          message_id: string
          sender_id: string
          receiver_id: string
          content: string
          chat_type?: string | null
          flagged: boolean
          flag_type?: string | null
          confidence: number
          matched_patterns?: string | null
          scanned_at: string
        }
        Insert: Omit<Database['public']['Tables']['chat_scan_logs']['Row'], 'id' | 'scanned_at'>
        Update: Partial<Database['public']['Tables']['chat_scan_logs']['Row']>
      }

      // ── ai_usage_logs ────────────────────────────────────────────────────────
      ai_usage_logs: {
        Row: {
          id: string
          user_id: string
          feature: string
          tokens_used: number
          cost: number
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['ai_usage_logs']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['ai_usage_logs']['Row']>
      }

      // ── user_feedback ────────────────────────────────────────────────────────
      user_feedback: {
        Row: {
          id: string
          user_id: string
          feedback_type: string
          rating: number
          comment?: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['user_feedback']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['user_feedback']['Row']>
      }

      // ── payout_requests ──────────────────────────────────────────────────────
      payout_requests: {
        Row: {
          id: string
          user_id: string
          amount: number
          bank_name: string
          account_number: string
          status: 'pending' | 'processing' | 'completed' | 'rejected'
          created_at: string
          processed_at?: string | null
        }
        Insert: Omit<Database['public']['Tables']['payout_requests']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['payout_requests']['Row']>
      }

      // ── processed_webhooks ───────────────────────────────────────────────────
      processed_webhooks: {
        Row: {
          id: string
          webhook_id: string
          event_type: string
          processed: boolean
          error_message?: string | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['processed_webhooks']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['processed_webhooks']['Row']>
      }

      // ── dispute_records ──────────────────────────────────────────────────────
      dispute_records: {
        Row: {
          id: string
          transaction_id: string
          raised_by: string
          dispute_type: string
          description: string
          status: 'open' | 'under_review' | 'resolved' | 'escalated'
          created_at: string
          resolved_at?: string | null
        }
        Insert: Omit<Database['public']['Tables']['dispute_records']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['dispute_records']['Row']>
      }

      // ── behavior_events ──────────────────────────────────────────────────────
      behavior_events: {
        Row: {
          id: string
          user_id: string
          event_type: string
          severity: 'low' | 'medium' | 'high'
          metadata?: Json | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['behavior_events']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['behavior_events']['Row']>
      }

      // ── system_quests ────────────────────────────────────────────────────────
      system_quests: {
        Row: {
          id: string
          quest_name: string
          description: string
          reward_amount: number
          quest_type: string
          requirements?: Json | null
          active: boolean
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['system_quests']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['system_quests']['Row']>
      }

      // ── gps_spoof_log ────────────────────────────────────────────────────────
      // Issue #7 fix: table was missing entirely from the schema definition.
      gps_spoof_log: {
        Row: {
          id: string
          user_id: string
          transaction_id?: string | null
          reason: string
          reported_lat: number
          reported_lng: number
          speed_ms?: number | null
          created_at: string
        }
        Insert: Omit<Database['public']['Tables']['gps_spoof_log']['Row'], 'id' | 'created_at'>
        Update: Partial<Database['public']['Tables']['gps_spoof_log']['Row']>
      }

    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Named row-type aliases — convenience re-exports for component consumption.
// These are NOW declared AFTER `Database` so there is no forward-reference
// or circular dependency issue under `isolatedModules: true`.
// ─────────────────────────────────────────────────────────────────────────────

export type Gig                = Database['public']['Tables']['gigs']['Row']
export type Notification       = Database['public']['Tables']['notifications']['Row']
export type ActivityFeed       = Database['public']['Tables']['activity_feed']['Row']
export type Message            = Database['public']['Tables']['messages']['Row']
export type LostFound          = Database['public']['Tables']['lost_found']['Row']
export type AllowedDomain      = Database['public']['Tables']['allowed_domains']['Row']
export type StudyPool          = Database['public']['Tables']['study_pools']['Row']
export type Rating             = Database['public']['Tables']['ratings']['Row']
export type ScheduledJob       = Database['public']['Tables']['scheduled_jobs']['Row']
export type ProfileRating      = Database['public']['Tables']['profile_ratings']['Row']
export type GigBooking         = Database['public']['Tables']['gig_bookings']['Row']
export type ListingView        = Database['public']['Tables']['listing_views']['Row']
export type ChatFlagLog        = Database['public']['Tables']['chat_flag_log']['Row']
export type TrendingListing    = Database['public']['Tables']['trending_listings']['Row']
export type Listing            = Database['public']['Tables']['listings']['Row']
export type TickerEvent        = Database['public']['Tables']['ticker_events']['Row']
export type Transaction        = Database['public']['Tables']['transactions']['Row']
export type ListingExifFlag    = Database['public']['Tables']['listing_exif_flags']['Row']
export type PriceFloorLog      = Database['public']['Tables']['price_floor_log']['Row']
export type Streak             = Database['public']['Tables']['streaks']['Row']
export type UserSecurity       = Database['public']['Tables']['user_security']['Row']
export type BannedDevice       = Database['public']['Tables']['banned_devices']['Row']
export type PasskeyCredential  = Database['public']['Tables']['passkey_credentials']['Row']
export type EmergencySaleToken = Database['public']['Tables']['emergency_sale_tokens']['Row']
export type PublicProfileStat  = Database['public']['Tables']['public_profile_stats']['Row']
export type SafeZone           = Database['public']['Tables']['safe_zones']['Row']
export type ReferralEvent      = Database['public']['Tables']['referral_events']['Row']
export type Profile            = Database['public']['Tables']['profiles']['Row']
export type AuditLog           = Database['public']['Tables']['audit_logs']['Row']
export type JuryCase           = Database['public']['Tables']['jury_cases']['Row']
export type JuryVote           = Database['public']['Tables']['jury_votes']['Row']
export type BuddyLink          = Database['public']['Tables']['buddy_links']['Row']
export type AmberConfirmation  = Database['public']['Tables']['amber_confirmations']['Row']
export type PriorityRelistLog  = Database['public']['Tables']['priority_relist_log']['Row']
export type JurorReclaim       = Database['public']['Tables']['juror_reclaims']['Row']
export type PlugCreditLedger   = Database['public']['Tables']['plug_credit_ledger']['Row']
export type GlobalConfig       = Database['public']['Tables']['global_config']['Row']
export type ChatScanLog        = Database['public']['Tables']['chat_scan_logs']['Row']
export type AIUsageLog         = Database['public']['Tables']['ai_usage_logs']['Row']
export type UserFeedback       = Database['public']['Tables']['user_feedback']['Row']
export type PayoutRequest      = Database['public']['Tables']['payout_requests']['Row']
export type ProcessedWebhook   = Database['public']['Tables']['processed_webhooks']['Row']
export type DisputeRecord      = Database['public']['Tables']['dispute_records']['Row']
export type BehaviorEvent      = Database['public']['Tables']['behavior_events']['Row']
export type SystemQuest        = Database['public']['Tables']['system_quests']['Row']
export type GpsSpoofLog        = Database['public']['Tables']['gps_spoof_log']['Row']
