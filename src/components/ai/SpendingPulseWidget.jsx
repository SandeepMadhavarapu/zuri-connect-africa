import { Activity } from 'lucide-react';
import AISystemLoader from './AISystemLoader';

export default function SpendingPulseWidget() {
  const loader = async () => {
    const { getTransactions } = await import('@/lib/mpesa');
    const tx = getTransactions?.(10);
    return Array.isArray(tx) ? tx : null;
  };

  return (
    <AISystemLoader
      name="Spending Pulse"
      loader={loader}
      fallback={
        <div className="hesabu-card rounded-2xl p-3.5">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Activity size={11} className="text-hesabu-emerald" />
            <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest">Spending Pulse</p>
          </div>
          <p className="text-[11px] text-hesabu-muted">No spending data available</p>
        </div>
      }
    >
      {(txHistory) => {
        const safeTx = Array.isArray(txHistory) ? txHistory : [];
        const debits = safeTx.filter(t => t && t.amount && t.amount < 0);
        const total = debits.reduce((s, t) => s + Math.abs(Math.max(0, Number(t?.amount) || 0)), 0) || 0;
        const bundles = debits.filter(t => t?.type === 'bundle').reduce((s, t) => s + Math.abs(Math.max(0, Number(t?.amount) || 0)), 0) || 0;
        const airtime = debits.filter(t => t?.type === 'airtime').reduce((s, t) => s + Math.abs(Math.max(0, Number(t?.amount) || 0)), 0) || 0;

        return (
          <div className="hesabu-card rounded-2xl p-3.5">
            <div className="flex items-center gap-1.5 mb-2.5">
              <Activity size={11} className="text-hesabu-emerald" />
              <p className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-widest">Spending Pulse</p>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Total out', val: `KSh ${total.toLocaleString()}` },
                { label: 'Bundles',   val: `KSh ${bundles.toLocaleString()}` },
                { label: 'Airtime',   val: `KSh ${airtime.toLocaleString()}` },
              ].map(s => (
                <div key={s.label} className="text-center">
                  <p className="font-grotesk font-bold text-[14px] text-hesabu-paper">{s.val}</p>
                  <p className="text-[9px] text-hesabu-muted mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        );
      }}
    </AISystemLoader>
  );
}