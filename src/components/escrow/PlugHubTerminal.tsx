import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { Package, Lock, RefreshCcw, ShieldCheck, CornerDownRight, CheckCircle, AlertTriangle } from 'lucide-react';
import { toast } from 'react-hot-toast';

export type EscrowState = 
  | 'payment_pending'
  | 'funds_escrowed'
  | 'locker_deposited'
  | 'received_by_borrower'
  | 'return_deposited'
  | 'returned_to_owner'
  | 'funds_released_or_disputed';

const STATE_STEPS = [
  { id: 'payment_pending', label: 'Payment Pending', icon: Lock },
  { id: 'funds_escrowed', label: 'Funds Escrowed', icon: ShieldCheck },
  { id: 'locker_deposited', label: 'Locker Deposited', icon: Package },
  { id: 'received_by_borrower', label: 'Received by Borrower', icon: CornerDownRight },
  { id: 'return_deposited', label: 'Return Deposited', icon: Package },
  { id: 'returned_to_owner', label: 'Returned to Owner', icon: CheckCircle },
  { id: 'funds_released_or_disputed', label: 'Resolved / Released', icon: RefreshCcw }
];

export default function PlugHubTerminal({ rentalId }: { rentalId: string }) {
  const queryClient = useQueryClient();

  const { data: rental, isLoading } = useQuery({
    queryKey: ['gear_rentals', rentalId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gear_rentals')
        .select('*')
        .eq('id', rentalId)
        .single();
      if (error) throw error;
      return data;
    },
    refetchInterval: 5000 // poll for updates or use realtime
  });

  const advanceStateMutation = useMutation({
    mutationFn: async (newState: EscrowState) => {
      const { data, error } = await supabase
        .from('gear_rentals')
        .update({ current_state: newState })
        .eq('id', rentalId)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['gear_rentals', rentalId], data);
      toast.success(`Escrow state advanced to: ${data.current_state}`);
    },
    onError: () => {
      toast.error('Failed to advance escrow state.');
    }
  });

  if (isLoading) return <div className="p-8 text-center text-white/50 animate-pulse">Loading Terminal...</div>;
  if (!rental) return <div className="p-8 text-center text-red-500">Rental Not Found</div>;

  const currentStateIndex = STATE_STEPS.findIndex(s => s.id === rental.current_state);

  return (
    <div className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-6 shadow-2xl max-w-lg mx-auto">
      <div className="flex items-center justify-between mb-8">
        <h2 className="text-xl font-black text-white flex items-center gap-2">
          <ShieldCheck className="text-cyan" /> PlugHub Terminal
        </h2>
        <span className="text-xs bg-cyan/10 text-cyan px-3 py-1 rounded-full font-mono">
          ESCROW SECURED
        </span>
      </div>

      <div className="space-y-6">
        {STATE_STEPS.map((step, index) => {
          const isActive = index === currentStateIndex;
          const isPast = index < currentStateIndex;
          const Icon = step.icon;

          return (
            <motion.div 
              key={step.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.1 }}
              className={`flex items-start gap-4 ${isActive ? 'opacity-100' : isPast ? 'opacity-50' : 'opacity-20'}`}
            >
              <div className={`relative z-10 flex items-center justify-center w-10 h-10 rounded-full border-2 
                ${isActive ? 'border-cyan bg-cyan/10 text-cyan shadow-[0_0_15px_rgba(0,255,255,0.3)]' : 
                  isPast ? 'border-plug-green bg-plug-green/10 text-plug-green' : 
                  'border-white/20 bg-transparent text-white/40'}`}>
                <Icon size={16} />
              </div>
              <div className="flex-1 pt-2">
                <h3 className={`font-bold ${isActive ? 'text-white' : 'text-white/60'}`}>{step.label}</h3>
                {isActive && (
                  <motion.div 
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    className="mt-3 text-sm text-white/60 bg-black/20 p-3 rounded-lg border border-white/5"
                  >
                    <p className="mb-3">Awaiting verification for next phase.</p>
                    {index < STATE_STEPS.length - 1 && (
                      <button 
                        onClick={() => advanceStateMutation.mutate(STATE_STEPS[index + 1].id as EscrowState)}
                        disabled={advanceStateMutation.isPending}
                        className="bg-cyan/20 hover:bg-cyan/30 text-cyan font-semibold text-xs px-4 py-2 rounded-lg transition-colors w-full"
                      >
                        {advanceStateMutation.isPending ? 'Verifying...' : 'Simulate Verification'}
                      </button>
                    )}
                  </motion.div>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
