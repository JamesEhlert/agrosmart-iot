/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // v5.44.0: design tokens por papel (valores em src/app/styles/tokens.css, claro e escuro)
      textColor: {
        'ink': 'rgb(var(--tx-ink) / <alpha-value>)',
        'ink-muted': 'rgb(var(--tx-ink-muted) / <alpha-value>)',
        'ink-soft': 'rgb(var(--tx-ink-soft) / <alpha-value>)',
        'brand': 'rgb(var(--tx-brand) / <alpha-value>)',
        'brand-strong': 'rgb(var(--tx-brand-strong) / <alpha-value>)',
        'danger': 'rgb(var(--tx-danger) / <alpha-value>)',
        'warning': 'rgb(var(--tx-warning) / <alpha-value>)',
        'info': 'rgb(var(--tx-info) / <alpha-value>)',
        'info-strong': 'rgb(var(--tx-info-strong) / <alpha-value>)',
        'warning-strong': 'rgb(var(--tx-warning-strong) / <alpha-value>)',
      },
      backgroundColor: {
        'surface': 'rgb(var(--bg-surface) / <alpha-value>)',
        'canvas': 'rgb(var(--bg-canvas) / <alpha-value>)',
        'subtle': 'rgb(var(--bg-subtle) / <alpha-value>)',
        'sunken': 'rgb(var(--bg-sunken) / <alpha-value>)',
        'brand': 'rgb(var(--bg-brand) / <alpha-value>)',
        'brand-strong': 'rgb(var(--bg-brand-strong) / <alpha-value>)',
        'brand-soft': 'rgb(var(--bg-brand-soft) / <alpha-value>)',
        'brand-tint': 'rgb(var(--bg-brand-tint) / <alpha-value>)',
        'danger': 'rgb(var(--bg-danger) / <alpha-value>)',
        'info': 'rgb(var(--bg-info) / <alpha-value>)',
        'info-strong': 'rgb(var(--bg-info-strong) / <alpha-value>)',
        'info-tint': 'rgb(var(--bg-info-tint) / <alpha-value>)',
        'danger-strong': 'rgb(var(--bg-danger-strong) / <alpha-value>)',
        'accent': 'rgb(var(--bg-accent) / <alpha-value>)',
      },
      borderColor: {
        'line': 'rgb(var(--bd-line) / <alpha-value>)',
        'brand-soft': 'rgb(var(--bd-brand-soft) / <alpha-value>)',
        'info-soft': 'rgb(var(--bd-info-soft) / <alpha-value>)',
        'brand': 'rgb(var(--bd-brand) / <alpha-value>)',
        'danger': 'rgb(var(--bd-danger) / <alpha-value>)',
        'info': 'rgb(var(--bd-info) / <alpha-value>)',
      },
      // v5.47.0: anel de foco (outline-focus / ring-focus), claro e escuro
      outlineColor: { 'focus': 'rgb(var(--focus-ring) / <alpha-value>)' },
      ringColor: { 'focus': 'rgb(var(--focus-ring) / <alpha-value>)' },
      gradientColorStops: {
        'brand': 'rgb(var(--st-brand) / <alpha-value>)',
        'brand-strong': 'rgb(var(--st-brand-strong) / <alpha-value>)',
      },
      colors: {
        agro: {
          primary: '#2E7D32',
          primaryDark: '#1B5E20',
          primaryLight: '#C8E6C9',
          accent: '#00E676',
          bg: '#F4F6F8',
          surface: '#FFFFFF',
          surfaceVariant: '#EEF2F5',
          borderLight: '#E0E6ED',
          textPrimary: '#1C252C',
          textSecondary: '#606F7B',
        }
      }
    },
  },
  plugins: [],
}