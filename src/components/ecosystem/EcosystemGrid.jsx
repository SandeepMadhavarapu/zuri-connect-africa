import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Search, Star, StarOff, Sparkles, X, Zap,
  HeartPulse, BookMarked, Car, FileText, Bus, Train, Fuel,
  GraduationCap, Tv, ShieldCheck, Building2, Users,
  Droplets, Wifi, Hospital, Landmark,
} from 'lucide-react';
import {
  ECOSYSTEM_CATEGORIES, ECOSYSTEM_SERVICES, AI_SERVICE_SUGGESTIONS,
  getFavorites, toggleFavorite, getRecentServices, recordServiceUsage,
} from '@/lib/ecosystemServices';

const ICON_MAP = {
  HeartPulse, BookMarked, Car, FileText, Bus, Train, Fuel,
  GraduationCap, Tv, ShieldCheck, Building2, Users, Zap,
  Droplets, Wifi, Hospital, Landmark,
};

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};
const itemAnim = {
  hidden: { opacity: 0, y: 10 },
  show:   { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 280, damping: 24 } },
};

function ServiceIcon({ name, size = 16, className }) {
  const Icon = ICON_MAP[name] || Zap;
  return <Icon size={size} className={className} />;
}

// Status badge palette collapsed into the Hesabu vocabulary: live/ready states
// read emerald, in-flight (pilot/soon) read brass, and informational states stay
// muted — all on one surface tile so the grid reads as a disciplined set.
const STATUS_BADGES = {
  payment_ready: {
    label: 'Payment-ready',
    className: 'bg-hesabu-surface-2 text-hesabu-emerald border-hesabu-line',
  },
  directory: {
    label: 'Directory',
    className: 'bg-hesabu-surface-2 text-hesabu-muted border-hesabu-line',
  },
  integration_ready: {
    label: 'Integration-ready',
    className: 'bg-hesabu-surface-2 text-hesabu-muted border-hesabu-line',
  },
  pilot: {
    label: 'Pilot',
    className: 'bg-hesabu-surface-2 text-hesabu-brass border-hesabu-line',
  },
  soon: {
    label: 'Soon',
    className: 'bg-hesabu-surface-2 text-hesabu-brass border-hesabu-line',
  },
  coming_soon: {
    label: 'Soon',
    className: 'bg-hesabu-surface-2 text-hesabu-brass border-hesabu-line',
  },
  available: {
    label: 'Available',
    className: 'bg-hesabu-surface-2 text-hesabu-emerald border-hesabu-line',
  },
  staging_ready: {
    label: 'Staging-ready',
    className: 'bg-hesabu-surface-2 text-hesabu-emerald border-hesabu-line',
  },
};

function ServiceCard({ service, isFav, onTap, onToggleFav }) {
  const status = STATUS_BADGES[service.status] || STATUS_BADGES.integration_ready;
  return (
    <motion.div variants={itemAnim} layout className="hesabu-card rounded-2xl p-3.5 relative">
      <button onClick={() => onToggleFav(service.id)} className="absolute top-2.5 right-2.5 p-1">
        {isFav
          ? <Star size={11} className="text-hesabu-brass fill-hesabu-brass" />
          : <StarOff size={11} className="text-hesabu-muted" />}
      </button>
      <button onClick={() => onTap(service)} className="w-full text-left">
        <div className="w-9 h-9 rounded-xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center mb-2.5">
          <ServiceIcon name={service.icon} size={16} className="text-hesabu-emerald" />
        </div>
        <p className="text-[12px] font-semibold text-hesabu-paper leading-tight pr-4">{service.title}</p>
        <p className="text-[10px] text-hesabu-muted mt-1 leading-relaxed line-clamp-2">{service.description}</p>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full border ${status.className}`}>{status.label}</span>
          {service.aiEnabled && (
            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-hesabu-surface-2 text-hesabu-emerald border border-hesabu-line flex items-center gap-1">
              <Sparkles size={7} /> AI
            </span>
          )}
        </div>
      </button>
    </motion.div>
  );
}

export default function EcosystemGrid() {
  const [category,   setCategory]   = useState('All');
  const [search,     setSearch]     = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [favorites,  setFavorites]  = useState(() => getFavorites());
  const [recentIds,  setRecentIds]  = useState(() => getRecentServices());

  const handleToggleFav = (id) => setFavorites(toggleFavorite(id));

  const handleTap = (service) => setRecentIds(recordServiceUsage(service.id));

  const filtered = useMemo(() => ECOSYSTEM_SERVICES.filter(s => {
    const matchCat    = category === 'All' || s.category === category;
    const matchSearch = !search || s.title.toLowerCase().includes(search.toLowerCase()) || s.description.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  }), [category, search]);

  const favServices    = ECOSYSTEM_SERVICES.filter(s => favorites.includes(s.id));
  const recentServices = recentIds.map(id => ECOSYSTEM_SERVICES.find(s => s.id === id)).filter(Boolean).slice(0, 4);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-paper/75">Explore Services</p>
        <button onClick={() => setShowSearch(s => !s)}
          className="w-8 h-8 rounded-xl bg-hesabu-surface border border-hesabu-line flex items-center justify-center">
          <Search size={12} className="text-hesabu-muted" />
        </button>
      </div>

      {/* Search */}
      <AnimatePresence>
        {showSearch && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden mb-3">
            <div className="flex items-center gap-2 hesabu-panel rounded-2xl px-3 py-2.5">
              <Search size={13} className="text-hesabu-muted shrink-0" />
              <input autoFocus value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search services…"
                className="flex-1 bg-transparent text-[13px] text-hesabu-paper placeholder:text-hesabu-muted outline-none" />
              {search && <button onClick={() => setSearch('')}><X size={12} className="text-hesabu-muted" /></button>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Category chips */}
      {!search && (
        <div className="chip-row mb-3">
          {ECOSYSTEM_CATEGORIES.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-[11px] font-bold transition-all border ${
                category === cat ? 'bg-hesabu-emerald text-hesabu-ink border-hesabu-emerald' : 'bg-hesabu-surface text-hesabu-muted border-hesabu-line'
              }`}>
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* AI Suggestions */}
      {!search && category === 'All' && (
        <div className="mb-4">
          <div className="flex items-center gap-1.5 mb-2.5">
            <Sparkles size={11} className="text-hesabu-emerald" />
            <p className="text-[10px] text-hesabu-paper/75 font-semibold uppercase tracking-[0.18em]">AI Suggested</p>
          </div>
          <div className="flex flex-col gap-2">
            {AI_SERVICE_SUGGESTIONS.map(sug => {
              const service = ECOSYSTEM_SERVICES.find(s => s.id === sug.serviceId);
              return (
                <motion.div key={sug.id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
                  className="hesabu-card rounded-2xl px-3.5 py-3 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center shrink-0">
                    <ServiceIcon name={sug.icon} size={14} className="text-hesabu-emerald" />
                  </div>
                  <p className="text-[12px] text-hesabu-paper leading-relaxed flex-1">{sug.text}</p>
                  {service && (
                    <button onClick={() => handleTap(service)}
                      className="shrink-0 text-[11px] font-semibold text-hesabu-emerald bg-hesabu-surface-2 border border-hesabu-line px-2.5 py-1 rounded-xl">
                      Explore
                    </button>
                  )}
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      {/* Favourites */}
      {!search && category === 'All' && favServices.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] text-hesabu-brass font-semibold uppercase tracking-[0.18em] mb-2.5 flex items-center gap-1.5">
            <Star size={9} className="text-hesabu-brass fill-hesabu-brass" /> Favourites
          </p>
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 gap-2.5">
            {favServices.map(s => <ServiceCard key={s.id} service={s} isFav onTap={handleTap} onToggleFav={handleToggleFav} />)}
          </motion.div>
        </div>
      )}

      {/* Recently used */}
      {!search && category === 'All' && recentServices.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] text-hesabu-paper/75 font-semibold uppercase tracking-[0.18em] mb-2.5">Recently Used</p>
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 gap-2.5">
            {recentServices.map(s => <ServiceCard key={s.id} service={s} isFav={favorites.includes(s.id)} onTap={handleTap} onToggleFav={handleToggleFav} />)}
          </motion.div>
        </div>
      )}

      {/* Main grid */}
      <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-2 gap-2.5">
        {filtered.map(s => <ServiceCard key={s.id} service={s} isFav={favorites.includes(s.id)} onTap={handleTap} onToggleFav={handleToggleFav} />)}
      </motion.div>

      {filtered.length === 0 && (
        <div className="text-center py-8">
          <p className="text-[13px] text-hesabu-muted">No services found</p>
        </div>
      )}
    </div>
  );
}
