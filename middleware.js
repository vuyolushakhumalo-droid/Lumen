// ============================================================
// Two jobs:
//  1. CORS for the API
//  2. Host routing — if a request arrives on a customer's domain
//     or a *.SITES_DOMAIN subdomain, serve their published site.
// ============================================================
import { NextResponse } from 'next/server';

const ALLOWED = [
  'http://localhost:3000',
  'http://localhost:8888',
  // add your real addresses here if you host the front end separately
];

function corsHeaders(origin) {
  const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

// Hosts that belong to Lumen itself, not to a customer site.
function isAppHost(host) {
  if (!host) return true;
  const h = host.toLowerCase().split(':')[0];
  if (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1') return true;
  if (h.endsWith('.vercel.app')) return true;                 // your deploy + previews
  const appUrl = process.env.APP_URL || '';
  try {
    const appHost = new URL(appUrl).hostname.toLowerCase();
    if (appHost && (h === appHost || h === 'www.' + appHost)) return true;
  } catch (e) { /* APP_URL not set yet */ }
  return false;
}

export function middleware(request) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host') || '';

  // --- customer sites on their own domain / subdomain ---
  if (!isAppHost(host) && !pathname.startsWith('/api/') && !pathname.startsWith('/_next/')) {
    const url = request.nextUrl.clone();
    url.pathname = `/d/${host.toLowerCase().split(':')[0]}`;
    return NextResponse.rewrite(url);
  }

  // --- API CORS ---
  if (pathname.startsWith('/api/')) {
    if (pathname.startsWith('/api/webhooks/')) return NextResponse.next();  // Stripe calls this server-to-server

    const origin = request.headers.get('origin') || '';
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
    }
    const response = NextResponse.next();
    Object.entries(corsHeaders(origin)).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
