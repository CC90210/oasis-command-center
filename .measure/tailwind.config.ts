import base from "../tailwind.config";
import type { Config } from "tailwindcss";

/** The app's own theme, with the harness's own files added to the content
 *  scan so nothing it renders is missing a class the app would have had. */
const config: Config = {
  ...base,
  content: [
    "../app/**/*.{js,ts,jsx,tsx,mdx}",
    "../components/**/*.{js,ts,jsx,tsx,mdx}",
    "./**/*.{ts,tsx,html}",
  ],
};

export default config;
