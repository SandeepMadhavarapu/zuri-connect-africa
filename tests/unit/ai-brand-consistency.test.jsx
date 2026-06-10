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

import { describe, expect, it } from 'vitest';

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

