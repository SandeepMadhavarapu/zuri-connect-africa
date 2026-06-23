import { Zap } from 'lucide-react';
import AISystemLoader from './AISystemLoader';

export default function FraudAlertsWidget() {
  const loader = async () => {
    const { getRecentThreats } = await import('@/lib/scamTelemetry');
    const threats = getRecentThreats?.(5);
    return Array.isArray(threats) && threats.length > 0 ? threats : null;
  };

  return (
    <AISystemLoader
      name="Fraud Alerts"
      loader={loader}
      fallback={
        <div className="hesabu-card rounded-2xl px-3.5 py-3 flex items-center gap-2">
          <Zap size={12} className="text-hesabu-emerald shrink-0" />
          <p className="text-[11px] text-hesabu-muted">No fraud alerts. Scam Shield is active.</p>
        </div>
      }
    >
      {(threats) => {
        const safeThreats = Array.isArray(threats) ? threats : [];
        return (
          <div className="hesabu-card rounded-2xl overflow-hidden">
            {safeThreats.slice(0, 3).map((t, i) => (
              <div key={i} className={`px-3.5 py-2.5 flex items-center gap-2 ${i < 2 ? 'border-b border-hesabu-line' : ''}`}>
                <div className="w-5 h-5 rounded bg-hesabu-danger/10 flex items-center justify-center shrink-0">
                  <Zap size={9} className="text-hesabu-danger" />
                </div>
                <p className="text-[11px] text-hesabu-paper/80">{t?.scamCategory || 'Fraud'} pattern · {t?.userAction}</p>
              </div>
            ))}
          </div>
        );
      }}
    </AISystemLoader>
  );
}