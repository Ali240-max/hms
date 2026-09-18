/**
 * Colour is defined once, as CSS variables, and Tailwind reads them.
 *
 * That indirection is what makes a dark mode possible without touching a
 * single screen: `bg-card` resolves to whatever --c-card currently is, so
 * flipping a class on <html> reskins the whole application.
 *
 * Two rules kept from the brief:
 *  - the gradient is only for the primary action button and small icon tiles
 *  - numeric results are primary or accent, never near-black
 */
const v = (name) => `rgb(var(${name}) / <alpha-value>)`

export default {
  darkMode: 'class',
  content: ['./src/client/index.html', './src/client/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: v('--c-primary'),
        accent:  v('--c-accent'),
        screen:  v('--c-screen'),
        card:    v('--c-card'),
        raised:  v('--c-raised'),
        line:    v('--c-line'),
        divide:  v('--c-divide'),
        heading: v('--c-heading'),
        body:    v('--c-body'),
        muted:   v('--c-muted'),
        ok:      v('--c-ok'),
        warn:    v('--c-warn'),
        bad:     v('--c-bad')
      },
      backgroundImage: {
        brand: 'linear-gradient(135deg, rgb(var(--c-primary)) 0%, rgb(var(--c-accent)) 100%)',
        tint:  'linear-gradient(180deg, rgb(var(--c-tint-a)) 0%, rgb(var(--c-tint-b)) 100%)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        urdu: ['"Noto Nastaliq Urdu"', 'Inter', 'serif'],
        mono: ['"Roboto Mono"', 'ui-monospace', 'monospace']
      },
      fontSize: { '2xs': ['0.6875rem', { lineHeight: '1rem' }] },
      boxShadow: {
        card: '0 1px 2px rgb(var(--c-shadow) / 0.06), 0 4px 12px -6px rgb(var(--c-shadow) / 0.14)',
        pop:  '0 16px 40px -12px rgb(var(--c-shadow) / 0.35)'
      }
    }
  },
  plugins: []
}
