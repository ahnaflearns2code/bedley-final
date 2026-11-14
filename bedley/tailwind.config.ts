import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#FAF8F4",
        ink: { DEFAULT: "#1C1F1D", soft: "#4A504C", faint: "#7A807C" },
        line: "#E4E1DA",
        forest: { DEFAULT: "#1F3D2E", 600: "#2A5240", 50: "#EEF3EF" },
        emerald: { accent: "#2F8F5B" },
        warn: "#B4541A",
        danger: "#A8322A",
      },
      fontFamily: { sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"] },
      borderRadius: { DEFAULT: "6px" },
    },
  },
  plugins: [],
} satisfies Config;
