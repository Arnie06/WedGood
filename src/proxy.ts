import type { NextRequest } from "next/server";
import { refreshSession } from "@/server/supabase/proxy-session";

export async function proxy(request: NextRequest) {
  return refreshSession(request);
}

export const config = {
  // Only routes that depend on a session; static assets and public pages are untouched.
  matcher: ["/app/:path*", "/invite/:path*", "/sign-in", "/sign-up"],
};
