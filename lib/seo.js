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

  const business = buildLocalBusiness(plan, {
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
