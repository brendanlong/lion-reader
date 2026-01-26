import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lion Reader",
    short_name: "Lion Reader",
    description: "A modern feed reader",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#f97316",
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
    ],
    // Share Target API: allows other Android apps to share URLs and files to Lion Reader
    // When a user shares content, the service worker intercepts the POST request,
    // stores the data in IndexedDB, and redirects to /save which reads it
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
