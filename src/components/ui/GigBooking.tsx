import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { Clock, Star, CheckCircle, Calendar, Zap, TrendingUp } from 'lucide-react'
import toast from 'react-hot-toast'

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

/**
 * GigPerformanceStats — shows jobs completed, avg response time, rating.
 * Used on the gig card and seller's profile.
 */
export function GigPerformanceStats({ gig, compact = false }) {
  const responseLabel = gig.avg_response_mins != null
    ? gig.avg_response_mins < 60
      ? `${Math.round(gig.avg_response_mins)}m`
      : `${(gig.avg_response_mins / 60).toFixed(1)}h`
    : '—'

  if (compact) return (
    <div className="flex items-center gap-3 text-xs text-white/50">
      <span className="flex items-center gap-1">
        <CheckCircle size={10} className="text-plug-green" />
        {gig.jobs_completed || 0} jobs
      </span>
      <span className="flex items-center gap-1">
        <Clock size={10} className="text-cyan" />
        {responseLabel} response
      </span>
      {gig.avg_rating > 0 && (
        <span className="flex items-center gap-1">
          <Star size={10} className="text-plug-amber fill-plug-amber" />
          {gig.avg_rating}
        </span>
      )}
    </div>
  )

  return (
    <div className="grid grid-cols-3 gap-2">
      <div className="bg-obsidian-300 rounded-xl p-3 text-center">
        <CheckCircle size={14} className="text-plug-green mx-auto mb-1" />
        <div className="text-base font-black text-plug-green font-mono">{gig.jobs_completed || 0}</div>
        <div className="text-[10px] text-white/40">Jobs Done</div>
      </div>
      <div className="bg-obsidian-300 rounded-xl p-3 text-center">
        <Clock size={14} className="text-cyan mx-auto mb-1" />
        <div className="text-base font-black text-cyan font-mono">{responseLabel}</div>
        <div className="text-[10px] text-white/40">Avg Response</div>
      </div>
      <div className="bg-obsidian-300 rounded-xl p-3 text-center">
        <Star size={14} className="text-plug-amber mx-auto mb-1" />
        <div className="text-base font-black text-plug-amber font-mono">
          {gig.avg_rating ? `${gig.avg_rating}★` : '—'}
        </div>
        <div className="text-[10px] text-white/40">Rating</div>
      </div>
    </div>
  )
}

/**
 * BookingSlotEditor — lets gig sellers configure their availability slots.
 * Stored as JSONB: [{ day, start, end, max_bookings }]
 */
export function BookingSlotEditor({ slots, onChange }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft]   = useState({ day: 'Monday', start: '09:00', end: '17:00', max_bookings: 3 })

  const addSlot = () => {
    onChange([...(slots || []), { ...draft, id: Date.now().toString() }])
    setAdding(false)
  }

  const removeSlot = (idx) => onChange((slots || []).filter((_, i) => i !== idx))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-bold text-white/50 uppercase tracking-wider">Availability Slots</div>
        <button onClick={() => setAdding(v => !v)}
          className="text-xs text-cyan hover:text-cyan/80 font-semibold transition-colors">
          + Add Slot
        </button>
      </div>

      {(slots || []).map((slot, i) => (
        <div key={slot.id || i} className="flex items-center justify-between bg-obsidian-300 rounded-xl px-4 py-2.5 text-sm">
          <div className="font-semibold">{slot.day}</div>
          <div className="text-white/50 text-xs">{slot.start} – {slot.end}</div>
          <div className="text-cyan text-xs font-mono">{slot.max_bookings} max</div>
          <button onClick={() => removeSlot(i)} className="text-white/20 hover:text-plug-red transition-colors text-base ml-2">×</button>
        </div>
      ))}

      <AnimatePresence>
        {adding && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="bg-obsidian-300 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Day</label>
                  <select className="input text-sm" value={draft.day}
                    onChange={e => setDraft(d => ({ ...d, day: e.target.value }))}>
                    {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Max Bookings</label>
                  <input className="input text-sm" type="number" min="1" max="10"
                    value={draft.max_bookings}
                    onChange={e => setDraft(d => ({ ...d, max_bookings: +e.target.value }))} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Start Time</label>
                  <input className="input text-sm" type="time"
                    value={draft.start} onChange={e => setDraft(d => ({ ...d, start: e.target.value }))} />
                </div>
                <div>
                  <label className="label">End Time</label>
                  <input className="input text-sm" type="time"
                    value={draft.end} onChange={e => setDraft(d => ({ ...d, end: e.target.value }))} />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={addSlot} className="btn-primary text-sm py-2 flex-1">Add Slot</button>
                <button onClick={() => setAdding(false)} className="btn-secondary text-sm py-2">Cancel</button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * BookGig — full instant booking UI for a gig.
 * Shows available slots, lets buyer pick a date/time, and creates booking.
 */
export function BookGig({ gig, onClose }) {
  const { user, profile } = useAuth()
  const qc = useQueryClient()
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [notes, setNotes]               = useState('')
  const [booking, setBooking]           = useState(false)

  const slots = gig.booking_slots || []

  // Fetch existing bookings for this gig (to show occupied slots)
  const { data: existingBookings = [] } = useQuery({
    queryKey: ['gig-bookings', gig.id, selectedDate],
    queryFn:  async () => {
      if (!selectedDate) return []
      const { data } = await supabase
        .from('gig_bookings')
        .select('slot_time, status')
        .eq('gig_id', gig.id)
        .eq('slot_date', selectedDate)
        .in('status', ['pending', 'confirmed'])
      return data || []
    },
    enabled: !!selectedDate,
  })

  const handleBook = async () => {
    if (!selectedSlot || !selectedDate) {
      toast.error('Select a date and time slot')
      return
    }
    setBooking(true)
    try {
      const { error } = await supabase.from('gig_bookings').insert({
        gig_id:     gig.id,
        client_id:  user.id,
        seller_id:  gig.seller_id,
        slot_date:  selectedDate,
        slot_time:  selectedSlot.time,
        notes:      notes || null,
        amount:     gig.starting_price,
        status:     'pending',
      })
      if (error) throw error

      // Notify seller
      await supabase.from('notifications').insert({
        user_id: gig.seller_id,
        type:    'new_booking',
        title:   '📅 New Booking Request!',
        body:    `${profile.full_name} wants to book "${gig.title}" on ${selectedDate} at ${selectedSlot.time}`,
        data:    { gig_id: gig.id, client_id: user.id },
      })

      toast.success('Booking request sent! Seller will confirm shortly.')
      qc.invalidateQueries({ queryKey: ['gig-bookings', gig.id] })
      onClose?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBooking(false)
    }
  }

  // Generate time slots from the selected day's slot config
  const dayOfWeek  = selectedDate ? DAYS[new Date(selectedDate).getDay()] : null
  const daySlot    = dayOfWeek ? slots.find(s => s.day === dayOfWeek) : null
  const timeSlots  = daySlot ? generateTimeSlots(daySlot.start, daySlot.end) : []
  const occupied   = existingBookings.map(b => b.slot_time)

  return (
    <div className="space-y-5">
      <div>
        <div className="text-xs font-bold text-white/50 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Calendar size={12} /> Select a Date
        </div>
        <input
          type="date"
          className="input"
          value={selectedDate}
          min={new Date().toISOString().split('T')[0]}
          onChange={e => { setSelectedDate(e.target.value); setSelectedSlot(null) }}
        />
        {selectedDate && !daySlot && (
          <p className="text-xs text-plug-amber mt-2">Not available on {dayOfWeek}s. Try another day.</p>
        )}
      </div>

      {daySlot && timeSlots.length > 0 && (
        <div>
          <div className="text-xs font-bold text-white/50 uppercase tracking-wider mb-3">
            Available Times
          </div>
          <div className="grid grid-cols-3 gap-2">
            {timeSlots.map(time => {
              const taken  = occupied.includes(time)
              const active = selectedSlot?.time === time
              return (
                <button
                  key={time}
                  disabled={taken}
                  onClick={() => setSelectedSlot({ time })}
                  className={`py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                    taken  ? 'border-obsidian-500 text-white/20 cursor-not-allowed line-through' :
                    active ? 'border-cyan bg-cyan/15 text-cyan' :
                             'border-obsidian-500 text-white/60 hover:border-cyan/40'
                  }`}
                >
                  {time}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {selectedSlot && (
        <div>
          <label className="label">Notes for the seller (optional)</label>
          <textarea className="input resize-none" rows={2}
            placeholder="Any specific requirements..."
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      )}

      {selectedSlot && (
        <div className="bg-obsidian-300 rounded-xl p-4">
          <div className="flex justify-between text-sm mb-1">
            <span className="text-white/60">{gig.title}</span>
            <span className="text-cyan font-mono font-bold">{formatNaira(gig.starting_price)}</span>
          </div>
          <div className="text-xs text-white/40">
            {selectedDate} at {selectedSlot.time}
          </div>
        </div>
      )}

      <button
        onClick={handleBook}
        disabled={!selectedSlot || booking}
        className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-40"
      >
        <Zap size={15} />
        {booking ? 'Sending Request...' : 'Book Instantly'}
      </button>

      <p className="text-xs text-center text-white/25">
        Payment collected on confirmation via PlugPay
      </p>
    </div>
  )
}

// Generate 30-min intervals between start and end
function generateTimeSlots(start: string, end: string): string[] {
  const slots: string[] = []
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let cur = sh * 60 + sm
  const fin = eh * 60 + em
  while (cur + 30 <= fin) {
    const h = Math.floor(cur / 60)
    const m = cur % 60
    slots.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
    cur += 60  // 1-hour slots
  }
  return slots
}
