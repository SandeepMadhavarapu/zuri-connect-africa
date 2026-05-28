import { useState } from 'react';
import { motion } from 'framer-motion';
import { Sparkles, TrendingUp, TrendingDown, AlertTriangle, Lightbulb, Loader2 } from 'lucide-react';
import { invokeLlm } from '@/services/aiService.js';
import { env } from '@/config/env.js';
import { getCategorySpend, DEFAULT_LIMITS } from './budgetData';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import { AI_BRAND, AI_FALLBACK } from '@/lib/branding/aiBrand';
import { buildBudgetLocalInsights, buildBudgetPrompt } from '@/lib/ai/contextBuilder';

const STATIC_INSIGHTS = [
  {
    icon: AlertTriangle,
    color: 'text-red-400',
    bg: 'bg-red-400/8',
    border: 'border-red-400/20',
    title: 'Shopping limit exceeded',
    body: 'You spent KSh 3,200 on shopping this month — 6.7% over your KSh 3,000 limit. Consider pausing discretionary purchases.',
  },
  {
    icon: TrendingDown,
    color: 'text-primary',
    bg: 'bg-primary/8',
    border: 'border-primary/20',
    title: 'Transport spending down',
    body: 'Great job! Transport costs dropped 69% vs April. You saved KSh 1,850 by using matatus more frequently.',
  },
  {
    icon: Lightbulb,
    color: 'text-yellow-400',
    bg: 'bg-yellow-400/8',
    border: 'border-yellow-400/20',
    title: 'Bundle upgrade saves money',
    body: 'Switching to the 20GB monthly bundle would save you KSh 349/month compared to your current mix of bundles.',
  },
  {
    icon: TrendingUp,
    color: 'text-blue-400',
    bg: 'bg-blue-400/8',
    border: 'border-blue-400/20',
    title: 'On track for savings goal',
    body: 'Your M-Shwari deposit of KSh 2,000 keeps you on track for your monthly savings target. Keep it up!',
  },
];

export default function AIInsightsPanel() {
  const [aiText, setAiText] = useState('');
  const [loading, setLoading] = useState(false);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState(null);

  const spend = (() => {
    try {
      const result = getCategorySpend?.();
      return (result && typeof result === 'object') ? result : {};
    } catch (e) {
      console.warn('[AIInsights] getCategorySpend error:', e);
      return {};
    }
  })();

  const fetchDeepInsight = async () => {
    setLoading(true);
    setAsked(true);
    setError(null);
    
    try {
      const safeSpend = spend || {};
      const localInsight = buildBudgetLocalInsights({ spend: safeSpend, limits: DEFAULT_LIMITS });

      if (!env.supabaseUrl || !env.supabaseAnonKey) {
        setAiText(`${localInsight} ${AI_FALLBACK.budgetConfigMissing}`);
        setError(null);
        setLoading(false);
        return;
      }

      try {
        const result = await Promise.race([
          invokeLlm({
            prompt: buildBudgetPrompt({ spend: safeSpend, limits: DEFAULT_LIMITS }),
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('AI timeout')), 15000)),
        ]);
        
        const responseText =
          typeof result === 'string'
            ? result
            : (result?.text ?? result?.data ?? '');
         if (!responseText || typeof responseText !== 'string') {
           setError(AI_FALLBACK.budgetEmpty);
           setAiText('');
           return;
         }
         const finalText = responseText.slice(0, 500).trim();
         if (!finalText) {
           setError(AI_FALLBACK.budgetEmpty);
           setAiText('');
           return;
         }
         setAiText(finalText);
         setError(null);
      } catch (aiErr) {
        console.error('[AIInsights] AI call failed:', aiErr?.message || aiErr);
        setAiText(`${localInsight} ${AI_FALLBACK.budgetUnavailable}`);
        setError(null);
      }
    } catch (e) {
      console.error('[AIInsights] Setup error:', e?.message || e);
      setAiText(`${buildBudgetLocalInsights({ spend, limits: DEFAULT_LIMITS })} ${AI_FALLBACK.budgetUnavailable}`);
      setError(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AppErrorBoundary>
    <div>
      {/* Duke AI Budget Intelligence CTA */}
      <div className="glass-card rounded-2xl p-4 mb-4" style={{ borderColor: 'rgba(0,200,83,0.18)' }}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-7 h-7 rounded-xl gradient-green flex items-center justify-center">
            <Sparkles size={13} className="text-black" />
          </div>
          <p className="text-sm font-bold text-foreground font-grotesk">{AI_BRAND.budgetIntelligence}</p>
        </div>
        {!asked ? (
          <>
            <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
              Get personalised recommendations based on your May spending patterns and Kenyan market conditions.
            </p>
            <button
              onClick={fetchDeepInsight}
              className="w-full gradient-green rounded-xl py-3 text-black font-bold text-sm flex items-center justify-center gap-2"
            >
              <Sparkles size={15} />
              Generate insights
            </button>
          </>
        ) : loading ? (
           <div className="flex items-center gap-2.5 py-2">
             <Loader2 size={16} className="text-primary animate-spin" />
             <p className="text-xs text-muted-foreground">Analysing your spending patterns…</p>
           </div>
         ) : error ? (
           <div className="text-xs text-muted-foreground py-2 leading-relaxed">
             <p>{error}</p>
             <button onClick={fetchDeepInsight} className="text-xs text-primary mt-2 font-medium">
               {AI_FALLBACK.retryCta} ↻
             </button>
           </div>
         ) : (
           <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}>
             <p className="text-sm text-foreground leading-relaxed">{aiText || AI_FALLBACK.budgetEmpty}</p>
             <button onClick={fetchDeepInsight} className="text-xs text-primary mt-2 font-medium">Refresh ↻</button>
           </motion.div>
         )}
      </div>

      {/* Static smart insights */}
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Smart Alerts</p>
      <div className="space-y-3">
        {STATIC_INSIGHTS.map((ins, i) => {
          const Icon = ins.icon;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className={`glass-card rounded-2xl p-4 ${ins.bg} border ${ins.border}`}
            >
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${ins.bg}`}>
                  <Icon size={15} className={ins.color} />
                </div>
                <div>
                  <p className={`text-xs font-bold mb-1 ${ins.color}`}>{ins.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{ins.body}</p>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
    </AppErrorBoundary>
  );
}
