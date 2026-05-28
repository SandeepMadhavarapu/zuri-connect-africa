import { useNavigate } from 'react-router-dom';
import { ArrowRight, TrendingDown, AlertTriangle, Lightbulb } from 'lucide-react';
import { AI_BRAND } from '@/lib/branding/aiBrand';

const insights = [
  {
    icon: TrendingDown,
    label: 'Spending Pattern',
    text: "Transport spend up 38% vs last week. Consider reviewing your commute budget.",
    color: "text-amber-400",
    bg: "bg-amber-400/8",
    tag: "Insight"
  },
  {
    icon: AlertTriangle,
    label: 'Account Notice',
    text: "An unrecognised login attempt was blocked. Additional verification may be required.",
    color: "text-red-400",
    bg: "bg-red-400/8",
    tag: "Security"
  },
  {
    icon: Lightbulb,
    label: 'Recommendation',
    text: "A 10GB monthly bundle may reduce your data costs by KSh 120 based on your usage.",
    color: "text-primary",
    bg: "bg-primary/8",
    tag: "Suggested"
  },
];

export default function AIPulse() {
  const navigate = useNavigate();
  const insight = insights[Math.floor(Date.now() / 12000) % insights.length];
  const Icon = insight.icon;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">Account Notices</p>
        <button onClick={() => navigate('/ai')} className="flex items-center gap-1 text-primary text-xs font-medium">
          {AI_BRAND.askCta} <ArrowRight size={11} />
        </button>
      </div>

      <div
        onClick={() => navigate('/ai')}
        className="glass-card rounded-2xl p-4 cursor-pointer active:bg-white/5 transition-all"
      >
        <div className="flex items-start gap-3">
          <div className={`w-8 h-8 rounded-xl ${insight.bg} flex items-center justify-center shrink-0 mt-0.5`}>
            <Icon size={14} className={insight.color} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">{insight.label}</span>
              <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${insight.bg} ${insight.color}`}>{insight.tag}</span>
            </div>
            <p className="text-foreground text-[13px] leading-relaxed">{insight.text}</p>
          </div>
        </div>
      </div>
    </div>
  );
}