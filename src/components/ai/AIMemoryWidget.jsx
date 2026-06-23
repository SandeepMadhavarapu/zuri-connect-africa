import AISystemLoader from './AISystemLoader';

export default function AIMemoryWidget() {
  const loader = async () => {
    const { getMemory } = await import('@/lib/ai/memory');
    const mem = getMemory?.();
    return mem && typeof mem === 'object' ? mem : null;
  };

  return (
    <AISystemLoader
      name="AI Memory"
      loader={loader}
      fallback={
        <div className="hesabu-card rounded-xl px-3.5 py-2.5">
          <p className="text-[11px] text-hesabu-muted">Memory system unavailable</p>
        </div>
      }
    >
      {(memory) => {
        const safeMem = memory && typeof memory === 'object' ? memory : { preferredLanguage: 'en', aiRecommendationHistory: [] };
        return (
          <div className="hesabu-card rounded-xl px-3.5 py-2.5">
            <p className="text-[11px] text-hesabu-muted">Language: <span className="text-hesabu-paper font-medium">{safeMem?.preferredLanguage || 'en'}</span></p>
            <p className="text-[11px] text-hesabu-muted mt-0.5">Recommendations tracked: <span className="text-hesabu-paper font-medium">{safeMem?.aiRecommendationHistory?.length || 0}</span></p>
          </div>
        );
      }}
    </AISystemLoader>
  );
}