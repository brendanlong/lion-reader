import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lion Reader",
    short_name: "Lion Reader",
    description: "A modern feed reader",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#f97316",
    // When the PWA is launched (e.g., via share target), focus the existing window
    // instead of navigating it. This prevents Android's share target from destroying
    // the current app state. The service worker handles the shared data via fetch
    // event and notifies the window via postMessage for the toast.
    launch_handler: {
      client_mode: ["focus-existing", "auto"],
    },
    icons: [
      {
        src: "/android-chrome-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/android-chrome-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/android-chrome-maskable-192x192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/android-chrome-maskable-512x512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    // Share Target API: allows other Android apps to share URLs and files to Lion Reader.
    // With launch_handler focus-existing, the service worker intercepts the POST,
    // saves URLs directly via API, and notifies the focused window via postMessage.
    // Files are stored in IndexedDB and the window redirects to /save for processing.
    share_target: {
      action: "/api/share",
      method: "POST" as const,
      enctype: "multipart/form-data" as const,
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [
          {
            name: "file",
            accept: [
              "text/plain",
              "text/markdown",
              "text/html",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ],
          },
        ],
      },
    },
  };
}
