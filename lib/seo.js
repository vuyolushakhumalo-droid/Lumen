// ============================================================
// SEO tags for published customer sites, injected at SERVE time --
// same approach as lib/forms.js and lib/analytics.js, and for the same
// two reasons: the model never has to write them correctly, and sites
// published before this existed pick them up without regenerating.
//
// What the model DOES provide is the raw material: the business facts
// it was told, recorded in the LUMEN-PLAN comment (see lib/anthropic.js).
// Nothing here invents a fact. A field absent from the plan is absent
// from the output -- a wrong address in structured data is worse for a
// local business than no address at all, because search engines will
// happily show it.
// ============================================================

/**
 * schema.org LocalBusiness subtypes we'll emit. The model picks a type
 * from the brief; anything not on this list falls back to the generic
 * LocalBusiness rather than being passed through, because an invented
 * @type makes the whole block invalid and Google drops all of it.
 */
const BUSINESS_TYPES = new Set([
  'LocalBusiness', 'ProfessionalService', 'Store',
  // food and drink
  'Restaurant', 'CafeOrCoffeeShop', 'Bakery', 'BarOrPub', 'FastFoodRestaurant',
  'IceCreamShop', 'Winery', 'Brewery', 'Distillery', 'CateringService',
  // health and beauty
  'HairSalon', 'BeautySalon', 'NailSalon', 'DaySpa', 'HealthClub', 'Gym',
  'Dentist', 'Physician', 'MedicalClinic', 'Optician', 'Pharmacy',
  'PhysicalTherapy', 'VeterinaryCare', 'TattooParlor',
  // trades and home
  'Plumber', 'Electrician', 'HVACBusiness', 'RoofingContractor', 'Locksmith',
  'HousePainter', 'GeneralContractor', 'HomeAndConstructionBusiness',
  'MovingCompany', 'Landscaper', 'CleaningService', 'PestControlService',
  // professional
  'Attorney', 'LegalService', 'AccountingService', 'InsuranceAgency',
  'FinancialService', 'RealEstateAgent', 'EmploymentAgency', 'Notary',
  'TravelAgency', 'Photographer', 'ChildCare', 'School', 'DrivingSchool',
  // retail
  'ClothingStore', 'GroceryStore', 'PetStore', 'HardwareStore', 'BookStore',
  'FurnitureStore', 'JewelryStore', 'ShoeStore', 'BikeStore', 'Florist',
  'GardenStore', 'ToyStore', 'SportingGoodsStore', 'MobilePhoneStore',
  // lodging and venues
  'Hotel', 'BedAndBreakfast', 'LodgingBusiness', 'EventVenue', 'SelfStorage',
  // motoring
  'AutoRepair', 'AutoDealer', 'AutoBodyShop', 'GasStation', 'CarWash',
]);

const HOURS_RE = /^(Mo|Tu|We|Th|Fr|Sa|Su)(-(Mo|Tu|We|Th|Fr|Sa|Su))?(,(Mo|Tu|We|Th|Fr|Sa|Su))*\s+([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

function attr(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * JSON-LD sits inside a <script>, where the parser is looking for
 * "</script" and nothing else. Escaping "<" defeats that without
 * changing what JSON.parse sees.
 */
function jsonForScript(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function firstMatch(html, re) {
  const m = String(html || '').match(re);
  return m ? m[1].trim() : '';
}

/**
 * Reads the LUMEN-PLAN comment straight out of stored HTML.
 *
 * Deliberately not lib/anthropic.js's extractPlan: that lives in a
 * module which pulls in the Anthropic SDK, and this runs on the public
 * site path where nothing should be loading an API client. Every value
 * it returns is validated where it's used, not here.
 */
export function parsePlan(html) {
  const m = String(html || '').match(/<!--\s*LUMEN-PLAN\s*(\{[\s\S]*?\})\s*-->/i);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** The <title> the model wrote -- it's instructed to use the business name. */
export function extractTitle(html) {
  return firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i).slice(0, 200);
}

export function extractDescription(html) {
  return firstMatch(
    html,
    /<meta[^>]*\sname\s*=\s*["']description["'][^>]*\scontent\s*=\s*["']([^"']*)["']/i
  ).slice(0, 300);
}

function codePoint(n) {
  // Surrogates and out-of-range values would throw; leave those alone.
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * Turns the entities a <title> or meta description realistically
 * carries back into text. Exported because the OG card needs the same
 * treatment -- "Fern &amp; Field" drawn literally into an image is the
 * kind of thing nobody notices until it is on someone's timeline.
 *
 * &amp; is decoded LAST on purpose: doing it first turns the
 * double-encoded "&amp;lt;" into "<" instead of the "&lt;" it means.
 */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

const decode = decodeEntities;

// ============================================================
// Corroboration
//
// plan.business is model output. The prompt tells it not to invent
// facts, but "don't invent" is a request, not a guarantee -- and a
// confidently invented phone number in structured data is the one
// failure here with a victim: whoever actually owns that number starts
// getting this business's calls, with Google vouching for it.
//
// So nothing is emitted unless the same fact is also on the page in
// visible text. The customer proof-reads their own site; they never see
// the JSON-LD. Anything that can't be corroborated is dropped.
// ============================================================

const COUNTRY_ALIASES = {
  GB: ['united kingdom', 'great britain', 'england', 'scotland', 'wales', 'uk'],
  UK: ['united kingdom', 'great britain', 'england', 'scotland', 'wales', 'uk'],
  IE: ['ireland', 'éire', 'eire'],
  US: ['united states', 'usa', 'america'],
  CA: ['canada'], AU: ['australia'], NZ: ['new zealand'],
};

const DAY_WORDS = {
  Mo: ['monday', 'mon'], Tu: ['tuesday', 'tue', 'tues'], We: ['wednesday', 'wed'],
  Th: ['thursday', 'thu', 'thur', 'thurs'], Fr: ['friday', 'fri'],
  Sa: ['saturday', 'sat'], Su: ['sunday', 'sun'],
};

/**
 * The page as a reader sees it: no markup, no scripts, and crucially no
 * comments -- the LUMEN-PLAN comment holds the very values being
 * checked, so leaving it in would make every claim corroborate itself.
 */
export function visibleText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const digitsOf = (s) => String(s || '').replace(/\D+/g, '');

/**
 * Phone numbers are written differently everywhere -- "+44 117 555
 * 0100" on one line, "0117 555 0100" on another. Comparing digits (and
 * trying the country-code/trunk-zero swap) checks it is the same
 * number, which is the actual question, rather than the same string.
 */
function phoneOnPage(pageDigits, phone) {
  const d = digitsOf(phone);
  if (d.length < 7) return false;              // too short to be meaningful
  const forms = new Set([d]);
  if (d.startsWith('44')) forms.add('0' + d.slice(2));
  if (d.startsWith('0')) forms.add('44' + d.slice(1));
  if (d.startsWith('1') && d.length === 11) forms.add(d.slice(1));
  return [...forms].some((f) => pageDigits.includes(f));
}

/** "09:00" also counts as 9:00, 9.00, 9am, 9 am, and the pm form. */
function timeOnPage(text, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const suffix = h < 12 ? 'am' : 'pm';
  const variants = [
    `${h}:${String(m).padStart(2, '0')}`,
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
    `${h12}:${String(m).padStart(2, '0')}`,
    `${h12}.${String(m).padStart(2, '0')}`,
  ];
  if (m === 0) variants.push(`${h12}${suffix}`, `${h12} ${suffix}`, `${h12}:00${suffix}`);
  else variants.push(`${h12}:${String(m).padStart(2, '0')}${suffix}`, `${h12}.${String(m).padStart(2, '0')}${suffix}`);
  return variants.some((v) => text.includes(v));
}

/**
 * Opening hours are stored in schema.org's form ("Mo-Fr 09:00-17:30")
 * and written on the page in prose ("Monday to Friday, 9am - 5.30pm"),
 * so a literal comparison would drop every real entry. Instead: at
 * least one named day must appear, and both times must appear in some
 * recognisable form.
 */
function hoursOnPage(text, entry) {
  const parts = String(entry).trim().split(/\s+/);
  if (parts.length !== 2) return false;
  const [daysPart, timesPart] = parts;
  const times = timesPart.split('-');
  if (times.length !== 2) return false;

  const dayOk = daysPart
    .split(/[-,]/)
    .some((d) => (DAY_WORDS[d] || []).some((w) => text.includes(w)));
  return dayOk && times.every((t) => timeOnPage(text, t));
}

/**
 * Drops every business fact the page doesn't back up.
 * @returns {{ business: object, dropped: string[] }}
 */
export function verifyBusinessFacts(business, html) {
  const b = business && typeof business === 'object' ? business : {};
  const text = visibleText(html);
  const pageDigits = digitsOf(text);
  const squashed = text.replace(/\s+/g, '');

  const kept = {};
  const dropped = [];
  const keep = (k, v) => { kept[k] = v; };
  const drop = (k) => { if (b[k] != null && String(b[k]).trim()) dropped.push(k); };

  // type is a classification, not a claim about a fact, so it stands on
  // its own -- there is no "Florist" string to find on a florist's page.
  if (b.type) keep('type', b.type);

  // name: the <title> is page content the customer sees in their tab,
  // so either source counts as corroboration.
  const titleText = decodeEntities(extractTitle(html)).toLowerCase();
  if (b.name) {
    const n = decodeEntities(b.name).toLowerCase().trim();
    if (n && (text.includes(n) || titleText.includes(n))) keep('name', b.name);
    else drop('name');
  }

  for (const k of ['street', 'locality', 'region']) {
    if (!b[k]) continue;
    const v = decodeEntities(b[k]).toLowerCase().trim();
    if (v && text.includes(v)) keep(k, b[k]);
    else drop(k);
  }

  if (b.postcode) {
    const pc = String(b.postcode).toLowerCase().replace(/\s+/g, '');
    if (pc && squashed.includes(pc)) keep('postcode', b.postcode);
    else drop('postcode');
  }

  if (b.country) {
    const c = String(b.country).trim();
    const aliases = COUNTRY_ALIASES[c.toUpperCase()] || [];
    const hit = text.includes(c.toLowerCase()) || aliases.some((a) => text.includes(a));
    if (hit) keep('country', b.country);
    else drop('country');
  }

  if (b.phone) {
    if (phoneOnPage(pageDigits, b.phone)) keep('phone', b.phone);
    else drop('phone');
  }

  if (b.email) {
    const e = String(b.email).toLowerCase().trim();
    if (e.includes('@') && text.includes(e)) keep('email', b.email);
    else drop('email');
  }

  if (Array.isArray(b.hours)) {
    const ok = b.hours.filter((h) => hoursOnPage(text, String(h)));
    if (ok.length) keep('hours', ok);
    if (ok.length < b.hours.length) dropped.push('hours');
  }

  return { business: kept, dropped };
}

/**
 * Builds the LocalBusiness block from plan.business. Returns null when
 * there isn't enough to say anything true -- a name is the floor, and a
 * block with only a @type in it is noise.
 */
export function buildLocalBusiness(plan, { url, name, image } = {}) {
  const b = (plan && plan.business) || {};
  const businessName = decode(b.name || name || '');
  if (!businessName) return null;

  const type = BUSINESS_TYPES.has(b.type) ? b.type : 'LocalBusiness';
  const node = { '@context': 'https://schema.org', '@type': type, name: businessName };

  if (url) node.url = url;
  if (image) node.image = image;
  if (b.phone) node.telephone = String(b.phone).slice(0, 40);
  if (b.email) node.email = String(b.email).slice(0, 120);

  // An address is only worth emitting with a locality or a postcode --
  // a lone street line is ambiguous enough to point somewhere wrong.
  const addr = {};
  if (b.street) addr.streetAddress = String(b.street).slice(0, 120);
  if (b.locality) addr.addressLocality = String(b.locality).slice(0, 80);
  if (b.region) addr.addressRegion = String(b.region).slice(0, 80);
  if (b.postcode) addr.postalCode = String(b.postcode).slice(0, 20);
  if (b.country) addr.addressCountry = String(b.country).slice(0, 40);
  if (addr.addressLocality || addr.postalCode) {
    node.address = { '@type': 'PostalAddress', ...addr };
  }

  // Only well-formed schema.org opening-hours strings. A malformed one
  // is worse than none: it invalidates the block.
  if (Array.isArray(b.hours)) {
    const hours = b.hours
      .map((h) => String(h).trim())
      .filter((h) => HOURS_RE.test(h))
      .slice(0, 7);
    if (hours.length) node.openingHours = hours;
  }

  return node;
}

/**
 * The whole head block: canonical, robots, Open Graph, Twitter card and
 * the LocalBusiness JSON-LD.
 *
 * @param {object}  o
 * @param {string}  o.html         the site's current code
 * @param {object}  o.plan         parsed LUMEN-PLAN, may be null
 * @param {string}  o.canonicalUrl absolute, with scheme
 * @param {string}  o.ogImageUrl   absolute, or '' to omit
 * @param {boolean} o.noindex
 */
export function buildSeoTags({ html, plan, canonicalUrl, ogImageUrl, noindex }) {
  const title = decode(extractTitle(html)) || decode((plan && plan.business && plan.business.name) || '');
  const description = decode(extractDescription(html));
  const tags = [];

  if (canonicalUrl) tags.push(`<link rel="canonical" href="${attr(canonicalUrl)}">`);

  tags.push(
    noindex
      ? '<meta name="robots" content="noindex,nofollow">'
      : '<meta name="robots" content="index,follow">'
  );

  if (title) {
    tags.push(`<meta property="og:title" content="${attr(title)}">`);
    tags.push(`<meta name="twitter:title" content="${attr(title)}">`);
  }
  if (description) {
    tags.push(`<meta property="og:description" content="${attr(description)}">`);
    tags.push(`<meta name="twitter:description" content="${attr(description)}">`);
  }
  if (canonicalUrl) tags.push(`<meta property="og:url" content="${attr(canonicalUrl)}">`);
  tags.push('<meta property="og:type" content="website">');
  if (title) tags.push(`<meta property="og:site_name" content="${attr(title)}">`);

  if (ogImageUrl) {
    tags.push(`<meta property="og:image" content="${attr(ogImageUrl)}">`);
    tags.push('<meta property="og:image:width" content="1200">');
    tags.push('<meta property="og:image:height" content="630">');
    if (title) tags.push(`<meta property="og:image:alt" content="${attr(title)}">`);
    tags.push('<meta name="twitter:card" content="summary_large_image">');
    tags.push(`<meta name="twitter:image" content="${attr(ogImageUrl)}">`);
  } else {
    tags.push('<meta name="twitter:card" content="summary">');
  }

  // Every fact is corroborated against the page before it can be
  // emitted. This is the only path that builds the JSON-LD, so an
  // unverified value has nowhere else to get out.
  const { business: verified, dropped } = verifyBusinessFacts(plan && plan.business, html);
  if (dropped.length) {
    console.warn('[seo] dropped uncorroborated business fields:', dropped.join(', '));
  }

  const business = buildLocalBusiness({ business: verified }, {
    url: canonicalUrl,
    name: title,
    image: ogImageUrl || undefined,
  });
  if (business) {
    tags.push(`<script type="application/ld+json">${jsonForScript(business)}</script>`);
  }

  return tags.join('\n');
}

/**
 * Inserts the block into the head. Existing <title> and description are
 * left alone -- the model wrote them, they're page content, and this
 * only adds what it isn't asked to write.
 */
export function injectSeo(html, opts) {
  const block = buildSeoTags({ html, ...opts });
  if (!block) return html;
  return html.includes('</head>')
    ? html.replace('</head>', `${block}\n</head>`)
    : block + html;
}
