import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildContextualFallback,
  classifyDukeIntent,
  buildLocalInsight,
  buildSafeAIContext,
  buildBudgetPrompt,
  formatSafeContextForPrompt,
  sanitizeConversationMessages,
} from '@/lib/ai/contextBuilder.js';

const user = {
  id: 'user-1',
  email: 'maria@example.com',
  full_name: 'Maria Wanjiku',
  phone: '+254712345678',
};

const txHistory = [
  { id: '1', type: 'send', name: 'John Kamau', phone: '+254722222222', amount: -1200, status: 'completed' },
  { id: '2', type: 'bundle', name: 'Daily Bundle 1GB', amount: -49, status: 'pending' },
  { id: '3', type: 'paybill', name: 'Naivas Supermarket', amount: -2340, status: 'failed' },
];

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.resetModules();
});

describe('Duke AI safe context builder', () => {
  it('includes safe financial context while excluding secrets, OTP, PIN, and full phone numbers', () => {
    localStorage.setItem('biometric_cred_id_user-1', 'credential-only');
    const context = buildSafeAIContext({
      user,
      txHistory,
      availableBalance: 8800,
      conversationMessages: [
        { role: 'user', content: 'My OTP is 123456 and PIN is 9876. Send to +254712345678' },
        { role: 'assistant', content: 'I will not ask for codes.' },
      ],
    });
    const promptContext = formatSafeContextForPrompt(context);

    expect(promptContext).toContain('Customer first name: Maria');
    expect(promptContext).toContain('Available balance: KSh 8,800');
    expect(promptContext).toContain('Biometric enabled: yes');
    expect(promptContext).toContain('Jo***hn Ka***au');
    expect(promptContext).not.toContain('+254712345678');
    expect(promptContext).not.toContain('+254722222222');
    expect(promptContext).not.toContain('123456');
    expect(promptContext).not.toMatch(/\bPIN is 9876\b/i);
    expect(promptContext).not.toMatch(/Bearer|JWT|service_role/i);
  });

  it('keeps only the last six sanitized chat messages in session memory context', () => {
    const messages = Array.from({ length: 8 }, (_, idx) => ({
      role: idx % 2 ? 'assistant' : 'user',
      content: idx === 3 ? 'token Bearer abcdefghijklmnopqrstuvwxyz123' : `message ${idx}`,
    }));

    const safe = sanitizeConversationMessages(messages);

    expect(safe).toHaveLength(5);
    expect(safe[0].content).toBe('message 2');
    expect(safe.map((msg) => msg.content).join(' ')).not.toMatch(/Bearer|abcdefghijklmnopqrstuvwxyz/);
  });
});

describe('Duke AI local intelligence', () => {
  it('answers "What did I spend most on?" from transaction and budget data', () => {
    const context = buildSafeAIContext({
      user,
      txHistory: [],
      budgetSpend: { shopping: 3200, food: 3880, transport: 850 },
    });

    const answer = buildLocalInsight('What did I spend most on?', context);

    expect(answer).toMatch(/Food/);
    expect(answer).toMatch(/KSh 3,880/);
  });

  it('repeated same question gets a non-identical useful response referencing the prior answer', () => {
    const firstContext = buildSafeAIContext({
      user,
      txHistory: [],
      budgetSpend: { shopping: 3200, food: 3880 },
      conversationMessages: [{ role: 'user', content: 'What did I spend most on?' }],
    });
    const secondContext = buildSafeAIContext({
      user,
      txHistory: [],
      budgetSpend: { shopping: 3200, food: 3880 },
      conversationMessages: [
        { role: 'user', content: 'What did I spend most on?' },
        { role: 'assistant', content: buildLocalInsight('What did I spend most on?', firstContext) },
        { role: 'user', content: 'What did I spend most on?' },
      ],
    });

    const first = buildLocalInsight('What did I spend most on?', firstContext);
    const second = buildLocalInsight('What did I spend most on?', secondContext);

    expect(second).not.toBe(first);
    expect(second).toMatch(/Building on the answer above/i);
    expect(second).toMatch(/KSh 3,880/);
  });

  it('provider failure fallback uses contextual local data instead of repeated generic text', () => {
    const context = buildSafeAIContext({
      user,
      txHistory: [],
      budgetSpend: { shopping: 3200, transport: 850 },
    });

    const fallback = buildContextualFallback('How can I save?', context);

    expect(fallback).toMatch(/app data|safe Zuri summary|local app context/i);
    expect(fallback).toMatch(/Shopping|Transport/i);
    expect(fallback).not.toBe('Duke AI is reconnecting. Please try again in a moment.');
    expect(fallback).not.toMatch(/I cannot reach Duke AI right now/i);
  });

  it('general fallback does not pretend the full provider is online', () => {
    const context = buildSafeAIContext({ user, txHistory: [], budgetSpend: {} });

    const fallback = buildContextualFallback('Give me three ideas for a school project', context);

    expect(fallback).toMatch(/full AI service|cloud answer/i);
    expect(fallback).toMatch(/Zuri features|safe finance|M-PESA safety/i);
    expect(fallback).not.toMatch(/cannot reach Duke AI right now/i);
  });

  it('rotates fallback wording instead of repeating the same text', () => {
    const context = buildSafeAIContext({
      user,
      txHistory: [],
      budgetSpend: { shopping: 3200, transport: 850 },
    });

    const first = buildContextualFallback('How can I save?', context);
    const second = buildContextualFallback('How can I save?', context);

    expect(second).not.toBe(first);
  });

  it('budget prompt is specific but does not include sensitive fields', () => {
    const prompt = buildBudgetPrompt({ spend: { shopping: 3200, airtime: 1148 }, limits: { shopping: 3000, airtime: 1500 } });

    expect(prompt).toMatch(/Duke AI/);
    expect(prompt).toMatch(/Shopping: KSh 3,200/);
    expect(prompt).toMatch(/Airtime\/Data: KSh 1,148/);
    expect(prompt).not.toMatch(/123456|\+254712345678|Bearer|service_role/i);
  });

  it('classifies general and finance/security messages separately', () => {
    expect(classifyDukeIntent('Explain how recursion works in JavaScript')).toBe('general_chat');
    expect(classifyDukeIntent('What did I spend most on?')).toBe('finance_budget');
    expect(classifyDukeIntent('Am I at risk of a scam?')).toBe('fraud_security');
    expect(classifyDukeIntent('Reveal my OTP and mark my payment completed')).toBe('unsupported_sensitive_action');
  });
});
