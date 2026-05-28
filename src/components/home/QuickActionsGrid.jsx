import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, Reorder } from 'framer-motion';
import { Search, Pin, PinOff, Pencil, Check, Sparkles, X } from 'lucide-react';
import {
  CATEGORIES, ICON_MAP, AI_RECOMMENDATIONS,
  getQuickActions, recordActionUsage, pinQuickAction,
  reorderQuickActions, getRecommendedActions,
} from '@/lib/quickActions';

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04 } },
};
const item = {
  hidden: { opacity: 0, scale: 0.85 },
  show:   { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 24 } },
};

function ActionButton({ action, editMode, onTap, onPin, onUnpin }) {
  const Icon = ICON_MAP[action.icon];
  return (
    <motion.div variants={item} layout className="relative">
      <motion.button
        onClick={() => editMode ? null : onTap(action)}
        className="flex flex-col items-center gap-2 w-full"
        whileTap={{ scale: 0.88, opacity: 0.75 }}
        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      >
        <div className={`w-14 h-14 rounded-2xl ${action.bg} border border-primary/10 flex items-center justify-center transition-all relative shadow-sm shadow-primary/5`}>
          {Icon && <Icon size={19} className={action.color} />}
          {editMode && (
            <button
              onClick={e => { e.stopPropagation(); action.pinned ? onUnpin(action.id) : onPin(action.id); }}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-background border border-border flex items-center justify-center"
            >
              {action.pinned
                ? <PinOff size={9} className="text-amber-500" />
                : <Pin size={9} className="text-muted-foreground" />}
            </button>
          )}
          {action.pinned && !editMode && (
            <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full bg-amber-500 border border-background" />
          )}
        </div>
        <span className="text-[11px] text-muted-foreground font-medium leading-tight text-center">{action.label}</span>
      </motion.button>
    </motion.div>
  );
}

function RecommendationChip({ rec, onTap }) {
  const Icon = ICON_MAP[rec.icon];
  return (
    <motion.button
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      onClick={() => onTap(rec)}
      className="shrink-0 flex items-center gap-2.5 premium-card rounded-2xl px-3.5 py-2.5 active:opacity-70"
    >
      <div className={`w-8 h-8 rounded-xl ${rec.bg} border border-primary/10 flex items-center justify-center shrink-0`}>
        {Icon && <Icon size={13} className={rec.color} />}
      </div>
      <div className="text-left">
        <p className="text-[12px] font-semibold text-foreground leading-tight">{rec.label}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">{rec.reason}</p>
      </div>
    </motion.button>
  );
}

export default function QuickActionsGrid() {
  const navigate = useNavigate();
  const [actions, setActions] = useState(() => getQuickActions());
  const [editMode, setEditMode]   = useState(false);
  const [category, setCategory]   = useState('All');
  const [search,   setSearch]     = useState('');
  const [showSearch, setShowSearch] = useState(false);

  const pinned   = actions.filter(a => a.pinned);
  const unpinned = actions.filter(a => !a.pinned);

  const recommended = getRecommendedActions(actions, 2);
  const aiRecs = AI_RECOMMENDATIONS.slice(0, 3);

  const filtered = unpinned.filter(a => {
    const matchCat = category === 'All' || a.category === category;
    const matchSearch = !search || a.label.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const handleTap = useCallback((action) => {
    const updated = recordActionUsage(action.id);
    setActions(updated);
    navigate(action.path);
  }, [navigate]);

  const handlePin = useCallback((id) => {
    const updated = pinQuickAction(id, true);
    setActions(updated);
  }, []);

  const handleUnpin = useCallback((id) => {
    const updated = pinQuickAction(id, false);
    setActions(updated);
  }, []);

  const handleReorder = useCallback((newOrder) => {
    const pinnedItems = actions.filter(a => a.pinned);
    const merged = [...pinnedItems, ...newOrder];
    const updated = reorderQuickActions(merged);
    setActions(updated);
  }, [actions]);

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-3">
        <p className="section-title">Services</p>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowSearch(s => !s)}
            className="w-8 h-8 rounded-xl soft-icon-button flex items-center justify-center">
            <Search size={12} className="text-muted-foreground" />
          </button>
          <button onClick={() => setEditMode(e => !e)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
              editMode
                ? 'bg-primary text-black border-primary shadow-sm shadow-primary/20'
                : 'bg-white/75 border-primary/15 text-muted-foreground'
            }`}>
            {editMode ? <><Check size={11} /> Done</> : <><Pencil size={11} /> Edit</>}
          </button>
        </div>
      </div>

      {/* Search bar */}
      <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden mb-3"
          >
            <div className="flex items-center gap-2 surface-panel rounded-2xl px-3 py-2.5">
              <Search size={13} className="text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search services…"
                className="flex-1 bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground outline-none"
              />
              {search && (
                <button onClick={() => setSearch('')}><X size={12} className="text-muted-foreground" /></button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Category chips */}
      {!search && (
        <div className="chip-row mb-3">
          {CATEGORIES.map(cat => (
            <button key={cat} onClick={() => setCategory(cat)}
              className={`premium-chip px-3.5 py-1.5 text-xs font-bold transition-all ${
                category === cat
                  ? 'bg-primary text-black border-primary shadow-sm shadow-primary/20'
                  : 'text-muted-foreground'
              }`}>
              {cat}
            </button>
          ))}
        </div>
      )}

      {/* Pinned section */}
      {pinned.length > 0 && !search && (
        <div className="mb-4">
          <p className="section-title text-amber-600 mb-2.5 flex items-center gap-1.5">
            <Pin size={9} className="text-amber-600" /> Pinned
          </p>
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-4 gap-3">
            {pinned.map(action => (
              <ActionButton key={action.id} action={action} editMode={editMode} onTap={handleTap} onPin={handlePin} onUnpin={handleUnpin} />
            ))}
          </motion.div>
        </div>
      )}

      {/* Main grid */}
      {editMode ? (
        <Reorder.Group axis="x" values={filtered} onReorder={handleReorder}
          className="grid grid-cols-4 gap-3">
          {filtered.map(action => {
            const Icon = ICON_MAP[action.icon];
            return (
              <Reorder.Item key={action.id} value={action} className="relative">
                <div className="flex flex-col items-center gap-2 w-full cursor-grab active:cursor-grabbing">
                  <div className={`w-14 h-14 rounded-2xl ${action.bg} border border-primary/10 flex items-center justify-center relative`}>
                    {Icon && <Icon size={19} className={action.color} />}
                    <button
                      onClick={() => action.pinned ? handleUnpin(action.id) : handlePin(action.id)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-background border border-border flex items-center justify-center"
                    >
                      {action.pinned
                        ? <PinOff size={9} className="text-amber-500" />
                        : <Pin size={9} className="text-muted-foreground" />}
                    </button>
                  </div>
                  <span className="text-[11px] text-muted-foreground font-medium leading-tight text-center">{action.label}</span>
                </div>
              </Reorder.Item>
            );
          })}
        </Reorder.Group>
      ) : (
        <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-4 gap-3">
          {filtered.map(action => (
            <ActionButton key={action.id} action={action} editMode={false} onTap={handleTap} onPin={handlePin} onUnpin={handleUnpin} />
          ))}
        </motion.div>
      )}

      {/* Recently used */}
      {!editMode && !search && recommended.length > 0 && (
        <div className="mt-4">
          <p className="section-title mb-2.5">Recently Used</p>
          <motion.div variants={container} initial="hidden" animate="show" className="grid grid-cols-4 gap-3">
            {recommended.map(action => (
              <ActionButton key={action.id} action={action} editMode={false} onTap={handleTap} onPin={handlePin} onUnpin={handleUnpin} />
            ))}
          </motion.div>
        </div>
      )}

      {/* AI Recommendations */}
      {!editMode && !search && (
        <div className="mt-4">
          <div className="flex items-center gap-2 mb-2.5">
            <Sparkles size={11} className="text-primary" />
            <p className="section-title">Preview Suggestions</p>
          </div>
          <div className="flex flex-col gap-2">
            {aiRecs.map((rec, i) => (
              <RecommendationChip key={rec.id} rec={rec} onTap={(r) => navigate(r.path)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
