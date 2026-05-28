import { useState } from 'react';
import { motion } from 'framer-motion';
import { Copy, Share2, Check } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';

export default function Receive() {
  const [copied, setCopied] = useState(false);
  const phone = '0712 345 678';
  const compactPhone = phone.replace(/\s/g, '');

  const copy = () => {
    navigator.clipboard.writeText(compactPhone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Use the Web Share API when available so the user gets the native share
  // sheet (WhatsApp, SMS, etc.). Falls back to clipboard with a toast so the
  // button never silently does nothing.
  const handleShare = async () => {
    const shareText = `Send M-PESA to ${phone} (Zuri Connect Africa).`;
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title: 'My M-PESA number', text: shareText });
        return;
      }
    } catch (err) {
      // User cancelled the share sheet — that's normal, fall through to clipboard fallback.
      if (err?.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(shareText);
      toast({
        title: 'Number copied to clipboard',
        description: 'Sharing is not available on this device — paste the number into your chat app.',
      });
    } catch {
      toast({
        title: 'Could not share',
        description: 'Tap "Copy" above to copy your M-PESA number.',
      });
    }
  };

  return (
    <div className="px-4 py-6 pb-8 flex flex-col items-center">
      <p className="text-muted-foreground text-sm text-center mb-6">
        Share your number or QR code to receive M-PESA payments
      </p>

      {/* QR Code placeholder */}
      <div className="w-56 h-56 rounded-3xl flex items-center justify-center mb-6 relative bg-white" style={{ border: '1px solid rgba(0,200,83,0.2)' }}>
        <div className="absolute inset-3 rounded-2xl border-2 border-primary/20" />

        {/* QR grid — bg-white ensures scannable contrast in all themes */}
        <div className="grid grid-cols-7 gap-0.5 p-4 bg-white rounded-xl">
          {Array.from({ length: 49 }).map((_, i) => {
            const row = Math.floor(i / 7);
            const col = i % 7;
            const isFinderPattern =
              (row < 2 && col < 2) ||
              (row < 2 && col > 4) ||
              (row > 4 && col < 2);
            const isDark = isFinderPattern || (i % 3 === 0) || (i % 5 === 0);
            return (
              <div
                key={i}
                className={`w-4 h-4 rounded-sm ${isDark ? 'bg-black' : 'bg-transparent'}`}
              />
            );
          })}
        </div>

        {/* Center logo */}
        <div className="absolute w-10 h-10 gradient-green rounded-xl flex items-center justify-center">
          <span className="text-black font-bold text-xs">Z</span>
        </div>
      </div>

      {/* Phone number */}
      <div className="w-full glass-card rounded-2xl px-4 py-4 mb-4">
        <p className="text-xs text-muted-foreground mb-1">Your M-PESA Number</p>
        <div className="flex items-center justify-between">
          <p className="font-grotesk text-2xl font-bold text-foreground">{phone}</p>
          <button
            onClick={copy}
            className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${
              copied ? 'bg-primary text-black' : 'surface2 border border-border/50 text-muted-foreground'
            }`}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>

      <motion.button
        type="button"
        onClick={handleShare}
        whileTap={{ scale: 0.97 }}
        aria-label="Share M-PESA number"
        className="w-full gradient-green rounded-2xl py-4 flex items-center justify-center gap-3 text-black font-bold text-sm"
      >
        <Share2 size={18} />
        Share M-PESA Number
      </motion.button>

      <div className="mt-6 p-4 rounded-2xl surface2 border border-border/50 w-full">
        <p className="text-xs text-muted-foreground text-center leading-relaxed">
          Anyone can send money directly to your M-PESA number. No bank account needed.
        </p>
      </div>
    </div>
  );
}
