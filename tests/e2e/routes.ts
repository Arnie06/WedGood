export const publicRoutes = ["/", "/design-system"] as const;

export const previewRoutes = [
  "/preview",
  "/preview/discover",
  "/preview/plan",
  "/preview/guests",
  "/preview/more",
] as const;

export const allRoutes = [...publicRoutes, ...previewRoutes];

export const viewports = [
  { name: "mobile-320", width: 320, height: 640 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;
