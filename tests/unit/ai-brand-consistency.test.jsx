/**
 * Pitch-safety: enforce a single AI brand voice across the frontend.
 *
 * - Assistant brand:  Duke AI
 * - Product brand:    Zuri Connect Africa  (NOT renamed — that's the app name)
 *
 * These tests guard against regressing to "Safi AI", "Zuri AI advisor",
 * or "Financial Advisor" as the assistant label. They also pin the polished
 * fallback copy so an outage never surfaces a "service temporarily
 * unavailable" string to a CEO demo.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';

import { AI_BRAND, AI_FALLBACK } from '@/lib/branding/aiBrand';

// ── Brand constants ─────────────────────────────────────────────────────────

describe('AI brand constants', () => {
  it('exposes a stable Duke AI name everywhere', () => {
    expect(AI_BRAND.name).toBe('Duke AI');
    expect(AI_BRAND.copilotHeader).toBe('Duke AI Copilot');
    expect(AI_BRAND.budgetIntelligence).toBe('Duke AI Budget Intelligence');
    expect(AI_BRAND.navLabel).toBe('Duke AI');
  });

  it('polished fallback copy never mentions "Safi" or "service unavailable"', () => {
    const all = Object.values(AI_FALLBACK).join(' ');
    expect(all).not.toMatch(/safi/i);
    expect(all).not.toMatch(/service\s+(?:temporarily\s+)?unavailable/i);
    expect(AI_FALLBACK.budgetUnavailable).toMatch(/Duke AI/);
    expect(AI_FALLBACK.chatUnavailable).toMatch(/Duke AI/);
  });
});

// ── Budget page render ──────────────────────────────────────────────────────

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({ user: { full_name: 'Madhavarapu Sandeep', email: 's@example.com' } }),
}));

vi.mock('@/components/budget/BudgetOverview', () => ({
  default: () => <div data-testid="budget-overview-stub" />,
}));
vi.mock('@/components/budget/SpendingByCategory', () => ({
  default: () => <div data-testid="spending-category-stub" />,
}));
vi.mock('@/components/budget/MonthlyTrendChart', () => ({
  default: () => <div data-testid="monthly-trend-stub" />,
}));
vi.mock('@/components/budget/BudgetLimitModal', () => ({
  default: () => null,
}));

async function renderBudget() {
  const { default: Budget } = await import('@/pages/Budget.jsx');
  return render(
    <MemoryRouter>
      <Budget />
    </MemoryRouter>,
  );
}

describe('Budget page — Duke AI brand', () => {
  it('renders "Duke AI" tab and does not show "Safi AI" anywhere', async () => {
    await renderBudget();
    // Tab label uses Duke AI (compact) for the insights tab.
    expect(screen.getAllByText('Duke AI').length).toBeGreaterThan(0);
    // Never the old brand.
    expect(screen.queryByText(/Safi AI/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Financial Advisor/i)).not.toBeInTheDocument();
  });

  it('has a bottom-safety spacer so the final alert is not clipped by the bottom nav', async () => {
    await renderBudget();
    const spacer = screen.getByTestId('budget-bottom-spacer');
    expect(spacer).toBeInTheDocument();
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
  });
});

// ── Budget AI Insights panel render ─────────────────────────────────────────

vi.mock('@/services/aiService.js', () => ({
  invokeLlm: vi.fn(async () => { throw new Error('AI timeout'); }),
}));

vi.mock('@/config/env.js', () => ({
  env: { supabaseUrl: 'https://example.supabase.co', supabaseAnonKey: 'anon' },
}));

vi.mock('@/components/budget/budgetData', () => ({
  CATEGORIES: [{ key: 'transport', label: 'Transport' }],
  DEFAULT_LIMITS: { transport: 3000 },
  MONTHLY_TREND: [],
  TRANSACTIONS: [],
  getCategorySpend: () => ({ transport: 1200 }),
}));

describe('Budget AIInsightsPanel — copy', () => {
  it('renders "Duke AI Budget Intelligence" as the deep analysis title', async () => {
    const { default: AIInsightsPanel } = await import('@/components/budget/AIInsightsPanel.jsx');
    render(<AIInsightsPanel />);
    expect(screen.getByText('Duke AI Budget Intelligence')).toBeInTheDocument();
    expect(screen.queryByText(/Safi AI/i)).not.toBeInTheDocument();
  });

  it('shows contextual Duke AI budget guidance when the provider is unreachable', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: AIInsightsPanel } = await import('@/components/budget/AIInsightsPanel.jsx');
    render(<AIInsightsPanel />);

    fireEvent.click(screen.getByRole('button', { name: /generate insights/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Transport is your largest May category at KSh 1,200/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/Duke AI is preparing your latest budget insight/i)).toBeInTheDocument();
    expect(screen.queryByText(/AI service temporarily unavailable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Safi/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
