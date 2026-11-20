/** GET /manifest.webmanifest: the board installed on a phone's home screen. */
export const MANIFEST = {
  name: "도리 보드",
  short_name: "도리",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  background_color: "#111317",
  theme_color: "#111317",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};
