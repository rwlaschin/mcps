import type { Config } from 'tailwindcss'

export default {
  theme: {
    extend: {
      colors: {
        // Reference dashboard: primary background and card surfaces
        surface: {
          DEFAULT: '#100B1A',
          card: '#1A1726',
          sidebar: '#0f0b14',
        },
        // Accent: vibrant purple (buttons, active states, highlights)
        accent: {
          DEFAULT: '#8B5CF6',
          hover: '#7C3AED',
          light: '#A78BFA',
        },
        // Chart/gradient accents from reference
        chart: {
          pink: '#EC4899',
          purple: '#8B5CF6',
          orange: '#F97316',
          blue: '#3B82F6',
        },
      },
      borderRadius: {
        card: '0.75rem',
        btn: '0.5rem',
      },
      boxShadow: {
        card: '0 4px 6px -1px rgb(0 0 0 / 0.2), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
        // Neon-Glass: glass pane hover elevation
        'glass-hover': '0 20px 40px -15px rgba(0,0,0,0.5)',
        // Neon-Glass: cyan glow (accent)
        'neon-cyan': '0 0 20px theme("colors.cyan.500 / 20%")',
        'neon-cyan/10': '0 0 15px theme("colors.cyan.500 / 10%")',
        'neon-cyan/20': '0 0 25px theme("colors.cyan.500 / 20%")',
      },
      backgroundImage: {
        // Neon-Glass: noise texture (Layer 3) – use external SVG to avoid banding
        noise: "url('https://grainy-gradients.vercel.app/noise.svg')",
      },
      transitionDuration: {
        '200': '200ms',
        '250': '250ms',
        '300': '300ms',
        '500': '500ms',
      },
      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'back-out': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
} satisfies Partial<Config>
