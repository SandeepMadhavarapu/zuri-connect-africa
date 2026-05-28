import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import LedgerTable from '../components/audit/LedgerTable';
import ReconciliationPanel from '../components/audit/ReconciliationPanel';
import AuditMetrics from '../components/audit/AuditMetrics';
import HashVerifier from '../components/audit/HashVerifier';
import { Shield, Activity, GitBranch, FileSearch, RefreshCw } from 'lucide-react';
import * as ledgerService from '@/services/ledgerService.js';
import * as reconciliationService from '@/services/reconciliationService.js';
import { runReconciliation } from '../lib/ledger';
import { readAllLocalLedgerEntries } from '@/lib/localLedgerStore.js';
import { mergeLedgerArrays } from '@/lib/ledgerMerge.js';

const TABS = [
  { id: 'ledger',    label: 'Immutable Ledger', icon: Activity },
  { id: 'recon',     label: 'Reconciliation',   icon: GitBranch },
  { id: 'audit',     label: 'Audit Trail',      icon: FileSearch },
];

export default function AuditDashboard() {
  const [tab,          setTab]         = useState('ledger');
  const [entries,      setEntries]     = useState([]);
  const [reconLogs,    setReconLogs]   = useState([]);
  const [loading,      setLoading]     = useState(true);
  const [running,      setRunning]     = useState(false);
  const [lastRecon,    setLastRecon]   = useState(null);

  const load = async () => {
    setLoading(true);
    const [remote, r] = await Promise.all([
      ledgerService.listLedger('-created_date', 100),
      reconciliationService.listReconciliationLogs('-created_date', 20),
    ]);
    const local = readAllLocalLedgerEntries();
    const merged = mergeLedgerArrays(local, remote || [], null);
    const e = [...merged].sort(
      (a, b) =>
        (Date.parse(String(b.created_date || '')) || 0) -
        (Date.parse(String(a.created_date || '')) || 0)
    ).slice(0, 100);
    setEntries(e || []);
    setReconLogs(r || []);
    if (r && r.length > 0) setLastRecon(r[0]);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleRunRecon = async () => {
    setRunning(true);
    const log = await runReconciliation();
    setLastRecon(log);
    await load();
    setRunning(false);
  };

  const totalDebits  = entries.filter(e => e.entryType === 'debit').reduce((s, e) => s + e.amount, 0);
  const totalCredits = entries.filter(e => e.entryType === 'credit').reduce((s, e) => s + e.amount, 0);
  const diff         = Math.abs(totalDebits - totalCredits);
  const balanced     = diff === 0;

  return (
    <div className="px-4 py-4 pb-10">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Shield size={13} className="text-primary" />
            </div>
            <span className="text-[10px] font-semibold text-primary uppercase tracking-widest">Internal · Restricted</span>
          </div>
          <h1 className="text-lg font-bold text-foreground font-grotesk leading-tight">Audit & Reconciliation</h1>
          <p className="text-[11px] text-muted-foreground mt-0.5">Double-entry ledger · Immutable audit trail</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl glass-card text-[11px] text-muted-foreground border border-white/8 active:opacity-70"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin text-primary' : ''} />
          Refresh
        </button>
      </div>

      {/* Metrics strip */}
      <AuditMetrics
        entries={entries}
        totalDebits={totalDebits}
        totalCredits={totalCredits}
        diff={diff}
        balanced={balanced}
        loading={loading}
      />

      {/* Run reconciliation CTA */}
      <button
        onClick={handleRunRecon}
        disabled={running}
        className="w-full flex items-center justify-between px-4 py-3.5 rounded-2xl mb-4 transition-all border"
        style={{
          background: balanced ? 'rgba(46,204,113,0.06)' : 'rgba(224,82,82,0.06)',
          borderColor: balanced ? 'rgba(46,204,113,0.18)' : 'rgba(224,82,82,0.22)',
        }}
      >
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${running ? 'animate-pulse bg-amber-400' : balanced ? 'bg-primary' : 'bg-red-400'}`} />
          <div className="text-left">
            <p className={`text-[12px] font-semibold ${balanced ? 'text-primary' : 'text-red-400'}`}>
              {running ? 'Running reconciliation…' : balanced ? 'Ledger Balanced' : `Discrepancy: KSh ${diff.toLocaleString()}`}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              {lastRecon ? `Last run: ${lastRecon.runDate} · ${lastRecon.entriesChecked} entries` : 'No reconciliation run yet'}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/8">
          <GitBranch size={10} className="text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground font-medium">Run</span>
        </div>
      </button>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 rounded-2xl bg-white/4 border border-white/6 mb-4">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[11px] font-semibold transition-all ${
                active ? 'bg-primary/12 text-primary border border-primary/20' : 'text-muted-foreground'
              }`}
            >
              <Icon size={11} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.15 }}
        >
          {tab === 'ledger' && <LedgerTable entries={entries} loading={loading} />}
          {tab === 'recon'  && <ReconciliationPanel logs={reconLogs} loading={loading} />}
          {tab === 'audit'  && <HashVerifier entries={entries} loading={loading} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}