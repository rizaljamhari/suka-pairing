/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(24 18% 82%)',
        input: 'hsl(24 18% 82%)',
        ring: 'hsl(17 82% 45%)',
        background: 'hsl(32 40% 96%)',
        foreground: 'hsl(24 22% 16%)',
        primary: {
          DEFAULT: 'hsl(17 82% 45%)',
          foreground: 'hsl(34 65% 98%)',
        },
        secondary: {
          DEFAULT: 'hsl(36 30% 90%)',
          foreground: 'hsl(24 24% 20%)',
        },
        muted: {
          DEFAULT: 'hsl(35 24% 92%)',
          foreground: 'hsl(24 12% 38%)',
        },
        accent: {
          DEFAULT: 'hsl(33 62% 88%)',
          foreground: 'hsl(24 24% 20%)',
        },
        destructive: {
          DEFAULT: 'hsl(0 72% 48%)',
          foreground: 'hsl(0 0% 98%)',
        },
        card: {
          DEFAULT: 'hsl(30 30% 99% / 0.92)',
          foreground: 'hsl(24 22% 16%)',
        },
      },
      borderRadius: {
        lg: '1rem',
        md: '0.75rem',
        sm: '0.5rem',
      },
      boxShadow: {
        panel: '0 22px 60px rgba(112, 78, 31, 0.12)',
      },
      fontFamily: {
        sans: ['Avenir Next', 'Nunito Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'shell-glow': 'radial-gradient(circle at top left, rgba(227, 132, 58, 0.2), transparent 28%), radial-gradient(circle at top right, rgba(209, 168, 79, 0.18), transparent 24%)',
      },
    },
  },
  plugins: [import('tailwindcss-animate')],
};