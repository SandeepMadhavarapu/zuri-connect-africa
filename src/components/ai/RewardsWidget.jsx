import AISystemLoader from './AISystemLoader';

export default function RewardsWidget() {
  const loader = async () => {
    const { getRewardsState } = await import('@/lib/rewardsEngine');
    const state = getRewardsState?.();
    return state && typeof state === 'object' ? state : null;
  };

  return (
    <AISystemLoader
      name="Rewards"
      loader={loader}
      fallback={
        <div className="glass-card rounded-2xl px-3.5 py-3 border border-white/6">
          <p className="text-[12px] text-muted-foreground">Rewards data unavailable</p>
        </div>
      }
    >
      {(rewards) => {
        const safeRewards = rewards && typeof rewards === 'object' ? rewards : { points: 0 };
        return (
          <div className="glass-card rounded-2xl px-3.5 py-3 border border-white/6 flex items-center justify-between">
            <p className="text-[12px] text-foreground">{(safeRewards?.points || 0).toLocaleString()} pts available</p>
            <span className="text-[10px] font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              ≈ KSh {((safeRewards?.points || 0) * 0.10).toFixed(0)}
            </span>
          </div>
        );
      }}
    </AISystemLoader>
  );
}