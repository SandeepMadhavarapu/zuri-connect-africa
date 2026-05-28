import { useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer
} from 'recharts';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { MONTHLY_TREND, CATEGORIES } from './budgetData';
import AppErrorBoundary from '@/components/AppErrorBoundary';

const SELECTED_CATS = ['transport', 'food', 'utilities', 'airtime', 'shopping'];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card rounded-xl px-3 py-2.5 text-xs shadow-lg" style={{ minWidth: 140 }}>
      <p className="font-semibold text-foreground mb-1.5">{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4 py-0.5">
          <span style={{ color: p.fill || p.stroke }}>{p.name}</span>
          <span className="font-grotesk font-semibold text-foreground">KSh {Number(p.value).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

function ChartPlaceholder() {
  return (
    <div className="glass-card rounded-2xl p-4 flex items-center justify-center" style={{ height: 240 }}>
      <p className="text-sm text-muted-foreground">Unable to render chart</p>
    </div>
  );
}

export default function MonthlyTrendChart() {
  const [chartType, setChartType] = useState('bar');
  const [activeCats, setActiveCats] = useState(['food', 'transport', 'utilities']);
  const [rangeMonths, setRangeMonths] = useState(3);

  const toggleCat = (k) => {
    setActiveCats(prev =>
      prev.includes(k)
        ? prev.length > 1 ? prev.filter(c => c !== k) : prev
        : [...prev, k]
    );
  };

  const safeCategories = Array.isArray(CATEGORIES) ? CATEGORIES : [];
  const catMap = Object.fromEntries(
    safeCategories
      .filter(c => c && typeof c === 'object' && c.key)
      .map(c => [c.key, c])
  );

  // Sanitize trend data with strict validation
   const safeTrends = (() => {
     try {
       if (!Array.isArray(MONTHLY_TREND)) return [];
       return MONTHLY_TREND.filter(d => 
         d && typeof d === 'object' && typeof d.month === 'string' && d.month.trim()
       );
     } catch (e) {
       console.error('[MonthlyTrendChart] Trend data validation error:', e);
       return [];
     }
   })();

   const chartData = (() => {
     try {
       if (safeTrends.length === 0) return [];

       return safeTrends.slice(-rangeMonths)
         .map((d, idx) => {
           if (!d || typeof d !== 'object') return null;

           const base = {
             month: String(d.month || `Month ${idx}`),
           };

           const withValues = SELECTED_CATS.reduce((acc, k) => {
             const val = Number(d[k]);
             // Strict NaN/negative check
             acc[k] = (typeof val === 'number' && !isNaN(val) && val >= 0) ? val : 0;
             return acc;
           }, base);

           // Ensure month is non-empty string
           if (!withValues.month || typeof withValues.month !== 'string') {
             return null;
           }

           return withValues;
         })
         .filter(item => item !== null);
     } catch (e) {
       console.error('[MonthlyTrendChart] Chart data transformation error:', e);
       return [];
     }
   })();

  // Month-over-month change for total (with NaN guards)
   const lastTwo = (() => {
     try {
       const slice = Array.isArray(chartData) ? chartData.slice(-2) : [];
       return slice.filter(d => d && typeof d === 'object');
     } catch {
       return [];
     }
   })();

   const prevTotal = (() => {
     if (lastTwo.length < 2) return 0;
     try {
       const prev = lastTwo[0];
       if (!prev || typeof prev !== 'object') return 0;
       return SELECTED_CATS.reduce((s, k) => {
         const val = Number(prev[k]) || 0;
         return s + Math.max(0, !isNaN(val) ? val : 0);
       }, 0);
     } catch {
       return 0;
     }
   })();

   const currTotal = (() => {
     if (lastTwo.length === 0) return 0;
     try {
       const curr = lastTwo[lastTwo.length - 1];
       if (!curr || typeof curr !== 'object') return 0;
       return SELECTED_CATS.reduce((s, k) => {
         const val = Number(curr[k]) || 0;
         return s + Math.max(0, !isNaN(val) ? val : 0);
       }, 0);
     } catch {
       return 0;
     }
   })();

   const delta = !isNaN(currTotal) && !isNaN(prevTotal) ? currTotal - prevTotal : 0;
   const deltaSign = delta >= 0 ? '+' : '';

  return (
    <AppErrorBoundary>
    <div>
      {/* MoM summary */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="glass-card rounded-2xl p-3.5">
          <p className="text-[11px] text-muted-foreground mb-1">This Month</p>
          <p className="font-grotesk font-bold text-lg text-foreground">KSh {Math.max(0, currTotal).toLocaleString()}</p>
          <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${delta > 0 ? 'text-red-400' : 'text-primary'}`}>
            {delta > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {deltaSign}{Math.abs(delta).toLocaleString()} vs Apr
          </div>
        </div>
        <div className="glass-card rounded-2xl p-3.5">
          <p className="text-[11px] text-muted-foreground mb-1">Avg / Month</p>
          <p className="font-grotesk font-bold text-lg text-foreground">
            KSh {chartData.length > 0 ? Math.max(0, Math.round((chartData.slice(0, 5).reduce((s, m) =>
              s + SELECTED_CATS.reduce((ss, k) => ss + Math.max(0, m?.[k] || 0), 0), 0) / Math.max(1, Math.min(5, chartData.length))))) : 0}
          </p>
          <p className="text-[11px] text-muted-foreground mt-1">Dec – Apr average</p>
        </div>
      </div>

      {/* Time range selector */}
      <div className="flex gap-1.5 mb-3">
        {[
          { label: '1M', value: 1  },
          { label: '3M', value: 3  },
          { label: 'All', value: 99 },
        ].map(({ label, value }) => (
          <button
            key={label}
            onClick={() => setRangeMonths(value)}
            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all ${
              rangeMonths === value
                ? 'bg-primary text-black'
                : 'bg-primary/8 border border-primary/15 text-muted-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Chart type toggle */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">6-Month Trend</p>
        <div className="flex gap-1 glass-card rounded-xl p-0.5">
          {['bar', 'area'].map(t => (
            <button key={t} onClick={() => setChartType(t)}
              className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-all ${
                chartType === t ? 'bg-primary text-black' : 'text-muted-foreground'
              }`}>
              {t === 'bar' ? 'Bar' : 'Area'}
            </button>
          ))}
        </div>
      </div>

      {/* Category filter pills */}
       <div className="flex gap-1.5 flex-wrap mb-4">
         {SELECTED_CATS.map(k => {
           const cat = catMap?.[k];
           if (!cat || !cat.color || !cat.emoji || !cat.label) {
             return (
               <div key={k} className="px-2.5 py-1 rounded-xl text-[11px] text-muted-foreground bg-white/5 border border-white/8">
                 {k}
               </div>
             );
           }
           const active = activeCats.includes(k);
           return (
             <button key={k} onClick={() => toggleCat(k)}
               className="px-2.5 py-1 rounded-xl text-[11px] font-semibold transition-all border"
               style={{
                 background: active ? `${cat.color}20` : 'transparent',
                 borderColor: active ? cat.color : 'rgba(255,255,255,0.08)',
                 color: active ? cat.color : '#6b7280',
               }}>
               {cat.emoji} {cat.label}
             </button>
           );
         })}
       </div>

      {/* Chart */}
      {!Array.isArray(chartData) || chartData.length === 0 ? (
         <ChartPlaceholder />
       ) : (
         <div className="glass-card rounded-2xl p-3 pb-1" style={{ height: 240 }}>
           <ResponsiveContainer width="100%" height={240}>
             {chartType === 'bar' ? (
               <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} axisLine={false} tickLine={false}
                  tickFormatter={v => v >= 1000 ? `${v/1000}k` : v} />
                <Tooltip content={<CustomTooltip />} />
                {Array.isArray(activeCats) && activeCats.map(k => {
                   if (!k || typeof k !== 'string') return null;
                   const cat = catMap?.[k];
                   if (!cat || !cat.color || typeof cat.color !== 'string' || !cat.label) {
                     return <Bar key={`bar-${k}`} dataKey={k} fill="rgba(255,255,255,0.05)" stackId="a" isAnimationActive={true} />;
                   }
                   try {
                     const isLast = k === (activeCats[activeCats.length - 1]);
                     return (
                       <Bar 
                         key={`bar-${k}`}
                         dataKey={k}
                         name={String(cat.label)}
                         stackId="a"
                         fill={cat.color}
                         radius={isLast ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                         isAnimationActive={true}
                       />
                     );
                   } catch (e) {
                     console.error('[MonthlyTrendChart] Bar render error:', e, k);
                     return <Bar key={`bar-${k}`} dataKey={k} fill="rgba(255,255,255,0.05)" stackId="a" isAnimationActive={true} />;
                   }
                 })}
              </BarChart>
            ) : (
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <defs>
                   {Array.isArray(activeCats) && activeCats.map(k => {
                     if (!k || typeof k !== 'string') return null;
                     const cat = catMap?.[k];
                     if (!cat || !cat.color || typeof cat.color !== 'string') {
                       return (
                         <linearGradient key={`grad-${k}`} id={`grad-${k}`} x1="0" y1="0" x2="0" y2="1">
                           <stop offset="5%" stopColor="rgba(255,255,255,0.1)" stopOpacity={0.35} />
                           <stop offset="95%" stopColor="rgba(255,255,255,0.1)" stopOpacity={0.03} />
                         </linearGradient>
                       );
                     }
                     try {
                       return (
                         <linearGradient key={`grad-${k}`} id={`grad-${k}`} x1="0" y1="0" x2="0" y2="1">
                           <stop offset="5%" stopColor={cat.color} stopOpacity={0.35} />
                           <stop offset="95%" stopColor={cat.color} stopOpacity={0.03} />
                         </linearGradient>
                       );
                     } catch (e) {
                       console.error('[MonthlyTrendChart] Gradient render error:', e, k);
                       return (
                         <linearGradient key={`grad-${k}`} id={`grad-${k}`} x1="0" y1="0" x2="0" y2="1">
                           <stop offset="5%" stopColor="rgba(255,255,255,0.1)" stopOpacity={0.35} />
                           <stop offset="95%" stopColor="rgba(255,255,255,0.1)" stopOpacity={0.03} />
                         </linearGradient>
                       );
                     }
                   })}
                 </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#6b7280', fontSize: 9 }} axisLine={false} tickLine={false}
                  tickFormatter={v => v >= 1000 ? `${v/1000}k` : v} />
                <Tooltip content={<CustomTooltip />} />
                {Array.isArray(activeCats) && activeCats.map(k => {
                   if (!k || typeof k !== 'string') return null;
                   const cat = catMap?.[k];
                   if (!cat || !cat.color || typeof cat.color !== 'string' || !cat.label) {
                     return (
                       <Area 
                         key={`area-${k}`}
                         type="monotone"
                         dataKey={k}
                         name={k}
                         stroke="rgba(255,255,255,0.1)"
                         fill="url(#grad-default)"
                         strokeWidth={2}
                         dot={false}
                         isAnimationActive={true}
                       />
                     );
                   }
                   try {
                     return (
                       <Area 
                         key={`area-${k}`}
                         type="monotone"
                         dataKey={k}
                         name={String(cat.label)}
                         stroke={cat.color}
                         fill={`url(#grad-${k})`}
                         strokeWidth={2}
                         dot={false}
                         isAnimationActive={true}
                       />
                     );
                   } catch (e) {
                     console.error('[MonthlyTrendChart] Area render error:', e, k);
                     return (
                       <Area 
                         key={`area-${k}`}
                         type="monotone"
                         dataKey={k}
                         name={k}
                         stroke="rgba(255,255,255,0.1)"
                         fill="url(#grad-default)"
                         strokeWidth={2}
                         dot={false}
                         isAnimationActive={true}
                       />
                     );
                   }
                 })}
              </AreaChart>
            )}
            </ResponsiveContainer>
         </div>
       )}
          </div>
          </AppErrorBoundary>
          );
          }