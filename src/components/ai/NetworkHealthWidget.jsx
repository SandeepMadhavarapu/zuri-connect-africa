import AISystemLoader from './AISystemLoader';

export default function NetworkHealthWidget() {
  const loader = async () => {
    const { getNetworkInsights } = await import('@/lib/network/networkAI');
    const insights = getNetworkInsights?.();
    return Array.isArray(insights) && insights.length > 0 ? insights : null;
  };

  return (
    <AISystemLoader
      name="Network Health"
      loader={loader}
      fallback={
        <div className="glass-card rounded-xl px-3.5 py-2.5 border border-white/6">
          <p className="text-[11px] text-muted-foreground">Network status normal</p>
        </div>
      }
    >
      {(insights) => {
        const safeInsights = Array.isArray(insights) ? insights : [];
        return (
          <div className="flex flex-col gap-1.5">
            {safeInsights.map((ins, i) => (
              <div key={i} className={`glass-card rounded-xl px-3.5 py-2.5 border ${ins?.type === 'warning' ? 'border-amber-400/15' : 'border-white/6'}`}>
                <p className="text-[11px] text-foreground/80 leading-relaxed">{ins?.text || 'No insight'}</p>
              </div>
            ))}
          </div>
        );
      }}
    </AISystemLoader>
  );
}