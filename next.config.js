/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,

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
      { source: '/community',  destination: '/community.html' },
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
};
