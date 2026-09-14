/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      spacing: {
        // Minimum touch target. The tablet is operated outdoors with wet
        // hands, so this is larger than a phone-sized tap target would be.
        touch: "3.5rem"
      }
    }
  },
  plugins: []
};
