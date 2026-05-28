/**
 * Zuri Connect Africa — Speech-to-Text Foundation
 * Architecture-ready mock. Future-compatible with Azure Speech / OpenAI Voice / Gemini Live.
 * Does NOT perform real voice biometric verification.
 */

export const STT_STATE = { IDLE: 'idle', LISTENING: 'listening', PROCESSING: 'processing', DONE: 'done', ERROR: 'error' };

/**
 * Start listening using the Web Speech API if available (Chrome/Edge).
 * Falls back gracefully on unsupported browsers.
 */
export function startListening({ onResult, onError, language = 'en-KE' }) {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    onError?.({ code: 'NOT_SUPPORTED', message: 'Speech recognition not available on this device.' });
    return null;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new SpeechRecognition();
  recognition.lang = language;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const confidence = event.results[0][0].confidence;
    onResult?.({ transcript, confidence });
  };

  recognition.onerror = (event) => {
    onError?.({ code: event.error, message: event.message });
  };

  recognition.start();
  return recognition; // caller holds reference to call .stop()
}

export function stopListening(recognitionInstance) {
  try { recognitionInstance?.stop(); } catch {}
}

/**
 * Future integration point — Azure Cognitive Services Speech SDK.
 * Replace this stub when azure-cognitiveservices-speech-sdk is installed.
 */
export async function transcribeWithAzure(audioBlob, apiKey, region) {
  throw new Error('Azure Speech integration not yet configured. Provide AZURE_SPEECH_KEY and AZURE_SPEECH_REGION.');
}