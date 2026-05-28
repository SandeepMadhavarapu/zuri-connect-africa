/**
 * OpenAI Provider — strongest reasoning, multilingual (Swahili/Sheng/English),
 * financial assistant, transaction explanations.
 */

import { withBreaker } from '../circuitBreaker.js';
import { invokeLlm } from '@/services/aiService.js';

export async function generateResponse({ systemPrompt, userMessage, context }) {
  const prompt = `${systemPrompt}\n\nContext:\n${context || 'none'}\n\nUser: ${userMessage}`;
  return withBreaker(
    'openai',
    async () => {
      const response = await invokeLlm({ prompt });
      if (response === undefined || response === null) {
        throw new Error('OpenAI returned empty response');
      }
      const out = typeof response === 'string' ? response : JSON.stringify(response);
      if (!String(out).trim()) {
        throw new Error('OpenAI returned empty body');
      }
      return out;
    },
    {
      failureThreshold: 5,
      cooldownMs: 60_000,
      probeTimeoutMs: 8_000,
    }
  );
}
