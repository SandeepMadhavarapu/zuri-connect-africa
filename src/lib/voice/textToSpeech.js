/**
 * Zuri Connect Africa — Text-to-Speech Foundation
 * Uses Web Speech Synthesis API. Future-compatible with Azure TTS / OpenAI Voice.
 */

const PREFERRED_VOICES = ['Zuri', 'Google Swahili', 'Microsoft Wanjiru', 'en-KE', 'en-GB'];

function getBestVoice() {
  const voices = window.speechSynthesis?.getVoices() || [];
  for (const pref of PREFERRED_VOICES) {
    const match = voices.find(v => v.name.includes(pref) || v.lang.includes(pref));
    if (match) return match;
  }
  return voices.find(v => v.lang.startsWith('en')) || voices[0] || null;
}

export function speak(text, { rate = 0.95, pitch = 1, volume = 1 } = {}) {
  if (!('speechSynthesis' in window)) return;

  window.speechSynthesis.cancel();

  const utterance  = new SpeechSynthesisUtterance(text);
  utterance.voice  = getBestVoice();
  utterance.rate   = rate;
  utterance.pitch  = pitch;
  utterance.volume = volume;
  utterance.lang   = 'en-KE';

  window.speechSynthesis.speak(utterance);
  return utterance;
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
}

export function isSpeaking() {
  return window.speechSynthesis?.speaking || false;
}