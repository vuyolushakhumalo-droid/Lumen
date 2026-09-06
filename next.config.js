/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

  // Runs instrumentation.js at server start, which is where Sentry is
  // initialised for both the node and edge runtimes. Still behind a
  // flag on Next 14; stable from 15.
  experimental: {
    instrumentationHook: true,
  },

  // Your website lives in /public as plain HTML files.
  // These rules give them clean URLs (/about instead of /about.html)
  // and serve the landing page at the root.
  async rewrites() {
    return [
      { source: '/',           destination: '/index.html' },
      { source: '/builder',    destination: '/lumen-builder.html' },
      { source: '/start',      destination: '/start.html' },
      { source: '/reset',      destination: '/reset.html' },
      { source: '/dashboard',  destination: '/dashboard.html' },
      { source: '/templates',  destination: '/templates.html' },
      { source: '/demos',      destination: '/demos.html' },
      { source: '/blog',       destination: '/blog.html' },
      { source: '/about',      destination: '/about.html' },
      { source: '/work',       destination: '/work.html' },
      { source: '/contact',    destination: '/contact.html' },
      { source: '/help',       destination: '/help.html' },
      { source: '/advisor',    destination: '/advisor.html' },
      { source: '/terms',      destination: '/terms.html' },
      { source: '/privacy',    destination: '/privacy.html' },
      { source: '/ownership',  destination: '/ownership.html' },
      { source: '/acceptable-use',  destination: '/acceptable-use.html' },
      { source: '/cookies',  destination: '/cookies.html' },
    ];
  },

  // Community was replaced by Demos -- keep old links working.
  async redirects() {
    return [
      { source: '/community', destination: '/demos', permanent: true },
    ];
  },
};
