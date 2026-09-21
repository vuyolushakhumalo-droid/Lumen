# Lintel self-audit rubric

Score each item pass / fail / n-a. A fail needs evidence (file:line or screenshot name).
Items marked [RULE] are hard rules from CLAUDE.md — a fail is automatically Critical.

## A. Copy and claims
- A1 [RULE] No occurrence of "credit" / "credits" on any page (grep public/ and app/).
  Exempt: public/blog-no-credits.html. That post argues against credit pricing, so the
  word is its subject; occurrences there are not a failure. Every other page still is.
- A2 [RULE] No "at cost", "no markup", "daily allowance".
- A3 [RULE] Studio is described as "by enquiry" — no number appears near it.
- A4 [RULE] No customer counts, uptime percentages, or features that don't exist.
- A5 Pricing page and homepage state the same plan names and prices.
- A6 British English throughout (colour, organisation, licence as a noun).
- A7 Every page has a unique, descriptive `<title>` and a meta description under 160 chars.
- A8 Legal pages (terms, privacy, refunds) exist, are linked from the footer, and dated.

## B. Navigation and structure
- B1 Header links are identical across all shared-header pages (diff them).
- B2 Footer links are identical across all shared-footer pages.
- B3 Every internal link resolves (no 404s) — crawl from `/`.
- B4 The current page is indicated in the nav (aria-current or visual state).
- B5 One `<h1>` per page, heading levels don't skip.
- B6 A visible "Back" or breadcrumb path exists from every deep page.
- B7 404 page exists, is styled, and links home.

## C. Accessibility (beyond axe)
- C1 Keyboard: every interactive element reachable by Tab, visible focus ring, no traps.
- C2 Skip-to-content link present on shared header.
- C3 Colour contrast ≥ 4.5:1 for body text, ≥ 3:1 for large text and UI borders.
- C4 Tap targets ≥ 44×44 CSS px on mobile screenshots (nav, buttons, form fields).
- C5 Images have meaningful alt text; decorative ones have `alt=""`.
- C6 Forms: labels associated, errors announced (aria-live or role=alert), error text
  says what to do, not just "invalid".
- C7 `prefers-reduced-motion` respected — no auto-playing motion when it is set.
- C8 Text can be zoomed to 200% without horizontal scroll or clipped content.
- C9 `lang="en-GB"` on `<html>`.

## D. Responsiveness (from the three screenshots)
- D1 No horizontal overflow at 375px.
- D2 No overlapping or clipped text at any of the three widths.
- D3 Nothing present on desktop is missing on mobile without an obvious way to reach it.
- D4 Tables and pricing grids reflow rather than shrink to unreadable.
- D5 Sticky header does not cover content or the LCP element on mobile.

## E. Performance and loading (beyond the Lighthouse number)
- E1 [RULE] No Google Fonts request; Inter is served from www.lintelapp.co.uk.
- E2 Homepage LCP element is the poster image, preloaded, with width/height set.
- E3 All images have explicit dimensions (no CLS from images).
- E4 Supabase JS is not in the initial request waterfall on marketing pages.
- E5 No render-blocking third-party script in `<head>`.
- E6 Cache headers: static assets ≥ 1 year immutable; HTML no-cache or short.
- E7 Total transfer for the homepage on mobile under 1 MB.

## F. Security and privacy surface
- F1 [RULE] reset.html loads zero third-party scripts (check network log, not just source).
- F2 HSTS, X-Frame-Options (or CSP frame-ancestors), Referrer-Policy, X-Content-Type-Options present.
- F3 No secrets, keys, or internal URLs in page source or inline scripts (grep for
  `sk_`, `service_role`, `eyJ`).
- F4 External links to other sites use `rel="noopener"`.
- F5 Cookie/analytics: any tracking script is disclosed in the privacy page.
- F6 Forms that POST have some abuse protection visible (rate limit, honeypot, or turnstile).

## G. Product surfaces (only if a test account is supplied)
- G1 Builder loads within 3s on desktop; first interaction is obvious.
- G2 Empty states exist (no sites yet, no clips yet) and say what to do next.
- G3 Error states: a failed build shows a message and a retry, not a blank.
- G4 Dashboard shows plan, allowance, and next billing date without a click.
- G5 Every destructive action (delete site, cancel) confirms first.
