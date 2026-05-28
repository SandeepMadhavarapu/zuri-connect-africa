export default function SkeletonCard({ lines = 3, className = '' }) {
  return (
    <div className={`glass-card rounded-2xl p-4 ${className}`}>
      <div className="space-y-3">
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i} className="skeleton h-3 rounded-full" />
        ))}
      </div>
    </div>
  );
}