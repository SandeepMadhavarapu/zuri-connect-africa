export default function HesabuLogo({ size = 96, showWordmark = false, tagline = false }) {
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label="Hesabu">
        <rect x="0" y="0" width="120" height="120" rx="28" fill="#0c1411" stroke="#1F9D6B" strokeOpacity="0.30" strokeWidth="2" />
        <line x1="44" y1="38" x2="44" y2="82" stroke="#1F9D6B" strokeWidth="12" strokeLinecap="round" />
        <line x1="76" y1="38" x2="76" y2="82" stroke="#1F9D6B" strokeWidth="12" strokeLinecap="round" />
        <line x1="44" y1="53" x2="76" y2="53" stroke="#C9A227" strokeWidth="6" strokeLinecap="round" />
        <line x1="44" y1="67" x2="76" y2="67" stroke="#C9A227" strokeWidth="6" strokeLinecap="round" />
      </svg>
      {showWordmark && (
        <div className="flex flex-col leading-none">
          <span className="text-[2.6rem] font-semibold tracking-tight text-hesabu-paper">Hesabu</span>
          {tagline && <span className="mt-1 text-sm text-hesabu-emerald">Pesa, pamoja</span>}
        </div>
      )}
    </div>
  );
}
