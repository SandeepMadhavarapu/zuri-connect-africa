/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        jakarta: ['Plus Jakarta Sans', 'sans-serif'],
        grotesk: ['Space Grotesk', 'sans-serif'],
        // Hesabu identity. `display` is additive (no existing `font-display`
        // usage). Money mono is intentionally NOT added as `fontFamily.mono`
        // here — overriding the global mono token would restyle Zuri audit/admin
        // pages that use `font-mono`. It is scoped in index.css instead.
        display: ['Space Grotesk', 'sans-serif'],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        '2xl': '1.25rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      colors: {
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))'
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))'
        },
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))'
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))'
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))'
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))'
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))'
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        chart: {
          '1': 'hsl(var(--chart-1))',
          '2': 'hsl(var(--chart-2))',
          '3': 'hsl(var(--chart-3))',
          '4': 'hsl(var(--chart-4))',
          '5': 'hsl(var(--chart-5))'
        },
        sidebar: {
          DEFAULT: 'hsl(var(--sidebar-background))',
          foreground: 'hsl(var(--sidebar-foreground))',
          primary: 'hsl(var(--sidebar-primary))',
          'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
          accent: 'hsl(var(--sidebar-accent))',
          'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
          border: 'hsl(var(--sidebar-border))',
          ring: 'hsl(var(--sidebar-ring))'
        },
        // Hesabu (chama) identity — maps to the .hesabu-theme scoped CSS vars
        // in src/index.css. These utilities are inert outside .hesabu-theme,
        // so they cannot affect existing Zuri pages.
        hesabu: {
          ink: 'var(--hesabu-ink)',
          surface: 'var(--hesabu-surface)',
          'surface-2': 'var(--hesabu-surface-2)',
          paper: 'var(--hesabu-paper)',
          muted: 'var(--hesabu-muted)',
          emerald: 'var(--hesabu-emerald)',
          'emerald-dim': 'var(--hesabu-emerald-dim)',
          brass: 'var(--hesabu-brass)',
          line: 'var(--hesabu-line)',
          danger: 'var(--hesabu-danger)'
        }
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' }
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' }
        },
        'pulse-green': {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(46, 204, 113, 0.3)' },
          '50%': { boxShadow: '0 0 0 8px rgba(46, 204, 113, 0)' }
        },
        'float': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' }
        },
        'slide-up': {
          from: { transform: 'translateY(20px)', opacity: '0' },
          to: { transform: 'translateY(0)', opacity: '1' }
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'pulse-green': 'pulse-green 2.5s ease-in-out infinite',
        'pulse-green-subtle': 'pulseGreenSubtle 3.5s ease-in-out infinite',
        'float': 'float 4s cubic-bezier(0.4, 0, 0.2, 1) infinite',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'slide-down': 'slideDown 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'shimmer': 'shimmer 1.5s infinite',
        'count-up': 'countUp 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'scale-in': 'scaleIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'slide-in-right': 'slideInRight 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      backgroundImage: {
        'gradient-green': 'linear-gradient(135deg, #00C853 0%, #00A846 100%)',
        'gradient-dark': 'linear-gradient(180deg, #0e150e 0%, #060a06 100%)',
        'gradient-radial': 'radial-gradient(circle, var(--tw-gradient-stops))',
      },
      boxShadow: {
        'green': '0 0 24px rgba(46, 204, 113, 0.14)',
        'green-sm': '0 0 12px rgba(46, 204, 113, 0.08)',
        'green-lg': '0 0 40px rgba(46, 204, 113, 0.16)',
        'card': '0 1px 3px rgba(0,0,0,0.6), 0 8px 32px rgba(0,0,0,0.4)',
      }
    }
  },
  safelist: [
    'text-green-400', 'text-amber-400', 'text-blue-400', 'text-red-400', 'text-violet-400', 'text-orange-400',
    'bg-green-400/8', 'bg-amber-400/8', 'bg-blue-400/8', 'bg-red-400/8', 'bg-violet-400/8',
    'border-amber-400/15', 'border-red-400/15', 'border-primary/15',
  ],
  plugins: [require("tailwindcss-animate")],
}
