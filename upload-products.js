require('dotenv').config();
require('@shopify/shopify-api/adapters/node');

const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const CSV_PATH = path.join(__dirname, 'data', 'products.csv');
const RATE_LIMIT_DELAY_MS = 1000; // 1 second between API calls to avoid 429s
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Validate Environment ───────────────────────────────────────────────────

const STORE_URL = (process.env.SHOPIFY_STORE_URL || '').trim();
const CLIENT_ID = (process.env.SHOPIFY_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.SHOPIFY_CLIENT_SECRET || '').trim();

if (!DRY_RUN && (!STORE_URL || !CLIENT_ID || !CLIENT_SECRET)) {
  console.error('\n❌ Missing required environment variables.');
  console.error('   Set SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID, and SHOPIFY_CLIENT_SECRET in .env');
  console.error('   See .env.example for details.\n');
  process.exit(1);
}

if (!fs.existsSync(CSV_PATH)) {
  console.error(`\n❌ CSV file not found: ${CSV_PATH}`);
  console.error('   Place your products.csv in the data/ directory.\n');
  process.exit(1);
}

// ─── Initialize Shopify Client ──────────────────────────────────────────────

// Clean the store domain → "my-store.myshopify.com"
const storeDomain = STORE_URL
  .replace(/^https?:\/\//, '')
  .replace(/\/+$/, '');

let shopifyInstance = null;

if (!DRY_RUN) {
  shopifyInstance = shopifyApi({
    apiSecretKey: CLIENT_SECRET,
    apiVersion: LATEST_API_VERSION,
    isCustomStoreApp: true,
    hostName: storeDomain,
    isEmbeddedApp: false,
    logger: { level: 0 }, // Suppress noisy SDK debug logs
  });
}

// ─── Token Fetching & Caching ───────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = null;

/**
 * Gets a valid Shopify access token using the Client Credentials Grant.
 * Caches the token and automatically refreshes it if it expires within 5 minutes.
 */
async function getAccessToken() {
  if (DRY_RUN) return 'dry-run-token';

  const now = Date.now();
  // Check if token exists and is valid for at least 5 minutes (300,000 ms)
  if (cachedToken && tokenExpiresAt && (tokenExpiresAt - now > 5 * 60 * 1000)) {
    return cachedToken;
  }

  console.log('🔑 Requesting new Shopify access token via Client Credentials grant...');

  try {
    const url = `https://${storeDomain}/admin/oauth/access_token`;
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', CLIENT_ID);
    params.append('client_secret', CLIENT_SECRET);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    const data = await response.json();
    if (!data.access_token) {
      throw new Error('No access_token returned in response.');
    }

    cachedToken = data.access_token;

    // Shopify client credentials tokens expire in 24 hours.
    // If expires_in is provided in response, use it, otherwise default to 24 hours (86400s)
    const expiresInSeconds = data.expires_in || 86400;
    tokenExpiresAt = now + (expiresInSeconds * 1000);

    console.log('🔑 New access token successfully retrieved and cached.');
    return cachedToken;
  } catch (error) {
    console.error('\n❌ Fatal: Failed to retrieve Shopify access token.');
    console.error(`   Error details: ${error.message}\n`);
    process.exit(1);
  }
}

// ─── Handle Generation ──────────────────────────────────────────────────────

/**
 * Generates a URL-friendly handle from a product title.
 * "My Cool Product!" → "my-cool-product"
 */
function generateHandle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')  // strip special chars
    .replace(/\s+/g, '-')          // spaces → hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '');        // trim leading/trailing hyphens
}

// ─── CSV Parsing ────────────────────────────────────────────────────────────

/**
 * Reads the CSV and returns a flat array of row objects.
 */
function readCSV() {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(CSV_PATH)
      .pipe(csv())
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

/**
 * Groups flat CSV rows into structured product objects.
 *
 * Shopify CSV convention:
 *   • The first row for a Handle carries product-level data (Title, Body, Vendor…)
 *   • Subsequent rows with the SAME Handle are additional variants
 *   • Each row may also contribute an image
 */
function groupRowsIntoProducts(rows) {
  const productMap = new Map();   // handle → product object
  const handleOrder = [];         // preserve CSV ordering

  for (const row of rows) {
    // ── Resolve handle ──
    let handle = (row['Handle'] || '').trim();
    const title = (row['Title'] || '').trim();

    if (!handle && title) {
      handle = generateHandle(title);
    }
    if (!handle) {
      console.warn('⚠️  Skipping row — no Handle or Title:', JSON.stringify(row).slice(0, 120));
      continue;
    }

    // ── First encounter → create product skeleton ──
    if (!productMap.has(handle)) {
      const product = {
        handle,
        title: title || handle,
        body_html: row['Body (HTML)'] || '',
        vendor: row['Vendor'] || '',
        product_type: row['Type'] || row['Product Type'] || '',
        tags: row['Tags'] || '',             // Shopify accepts comma-separated string
        status: (row['Status'] || 'draft').toLowerCase(),
        variants: [],
        images: [],
      };

      // Collect option definitions (up to 3)
      const options = [];
      for (let i = 1; i <= 3; i++) {
        const name = (row[`Option${i} Name`] || '').trim();
        if (name) options.push({ name });
      }
      if (options.length > 0) product.options = options;

      productMap.set(handle, product);
      handleOrder.push(handle);
    }

    const product = productMap.get(handle);

    // ── Build variant from this row ──
    const variant = {};

    // Price (required — map "Variant Price" → price)
    if (row['Variant Price']) variant.price = row['Variant Price'].toString();
    if (row['Variant Compare At Price']) variant.compare_at_price = row['Variant Compare At Price'].toString();

    // Identifiers
    if (row['Variant SKU']) variant.sku = row['Variant SKU'];
    if (row['Variant Barcode']) variant.barcode = row['Variant Barcode'];

    // Inventory
    if (row['Variant Inventory Qty']) variant.inventory_quantity = parseInt(row['Variant Inventory Qty'], 10);
    if (row['Variant Inventory Policy']) variant.inventory_policy = row['Variant Inventory Policy'].toLowerCase();
    if (row['Variant Fulfillment Service']) variant.fulfillment_service = row['Variant Fulfillment Service'].toLowerCase();

    // Weight
    if (row['Variant Grams']) variant.grams = parseInt(row['Variant Grams'], 10);
    if (row['Variant Weight Unit']) variant.weight_unit = row['Variant Weight Unit'].toLowerCase();

    // Shipping & tax
    if (row['Variant Requires Shipping'] !== undefined && row['Variant Requires Shipping'] !== '') {
      variant.requires_shipping = row['Variant Requires Shipping'] === 'true';
    }
    if (row['Variant Taxable'] !== undefined && row['Variant Taxable'] !== '') {
      variant.taxable = row['Variant Taxable'] === 'true';
    }

    // Option values (Shopify REST uses option1/option2/option3)
    if (row['Option1 Value']) variant.option1 = row['Option1 Value'];
    if (row['Option2 Value']) variant.option2 = row['Option2 Value'];
    if (row['Option3 Value']) variant.option3 = row['Option3 Value'];

    // Only add variant if it has at least a price or option
    if (Object.keys(variant).length > 0) {
      product.variants.push(variant);
    }

    // ── Collect image (map "Image Src" → images[].src) ──
    const imgSrc = (row['Image Src'] || '').trim();
    if (imgSrc && !product.images.some((img) => img.src === imgSrc)) {
      const image = { src: imgSrc };
      if (row['Image Position']) image.position = parseInt(row['Image Position'], 10);
      if (row['Image Alt Text']) image.alt = row['Image Alt Text'];
      product.images.push(image);
    }
  }

  // ── Post-processing ──
  return handleOrder.map((handle) => {
    const product = productMap.get(handle);

    // Guarantee at least one variant
    if (product.variants.length === 0) {
      product.variants.push({ price: '0.00' });
    }

    return product;
  });
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Validates each product against required Shopify fields.
 * Returns an array of { index, handle, issues[] }.
 */
function validateProducts(products) {
  const errors = [];

  const seenHandles = new Set();

  products.forEach((p, i) => {
    const issues = [];

    // Title is required
    if (!p.title) {
      issues.push('Missing "title" (required by Shopify)');
    }

    // Handle uniqueness
    if (seenHandles.has(p.handle)) {
      issues.push(`Duplicate handle "${p.handle}" — each product must have a unique handle`);
    }
    seenHandles.add(p.handle);

    // Every variant needs a price
    p.variants.forEach((v, vi) => {
      if (!v.price && v.price !== '0' && v.price !== '0.00') {
        issues.push(`Variant #${vi + 1} is missing a price`);
      }
    });

    // Image URLs should look valid
    p.images.forEach((img, ii) => {
      if (img.src && !img.src.startsWith('http')) {
        issues.push(`Image #${ii + 1} has invalid URL: "${img.src}"`);
      }
    });

    if (issues.length > 0) {
      errors.push({ index: i + 1, handle: p.handle, title: p.title, issues });
    }
  });

  return errors;
}

// ─── Shopify API Calls ──────────────────────────────────────────────────────

/**
 * Creates a single product via the Shopify Admin REST API.
 * POST /admin/api/{version}/products.json
 */
async function createProduct(productData) {
  const token = await getAccessToken();

  // Create a new session dynamically with the retrieved token
  const session = shopifyInstance.session.customAppSession(storeDomain);
  session.accessToken = token;

  const client = new shopifyInstance.clients.Rest({ session });

  const response = await client.post({
    path: 'products',
    data: { product: productData },
  });

  return response.body.product;
}

/**
 * Waits for the given number of milliseconds.
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Console UI Helpers ─────────────────────────────────────────────────────

function printBanner(productCount) {
  const mode = DRY_RUN ? '🔍 DRY RUN' : '🚀 LIVE';
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║              🛍️   Shopify Product Bulk Uploader               ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Mode:     ${mode.padEnd(51)}║`);
  if (!DRY_RUN) {
    console.log(`║  Store:    ${storeDomain.padEnd(51)}║`);
    console.log(`║  API:      ${LATEST_API_VERSION.padEnd(51)}║`);
  }
  console.log(`║  CSV:      ${path.basename(CSV_PATH).padEnd(51)}║`);
  console.log(`║  Products: ${String(productCount).padEnd(51)}║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // ── Step 1: Parse CSV ──
  console.log('📄 Reading CSV file...');
  const rows = await readCSV();
  console.log(`   Parsed ${rows.length} row(s) from CSV.`);

  console.log('🔗 Grouping rows into products...');
  const products = groupRowsIntoProducts(rows);

  printBanner(products.length);

  if (products.length === 0) {
    console.log('ℹ️  No products found. Check your CSV format.\n');
    return;
  }

  // ── Step 2: Validate ──
  console.log('✅ Validating products against Shopify schema...');
  const validationErrors = validateProducts(products);

  if (validationErrors.length > 0) {
    console.log(`\n⚠️  Found ${validationErrors.length} validation issue(s):\n`);
    for (const err of validationErrors) {
      console.log(`   Product #${err.index} "${err.title}" (${err.handle}):`);
      err.issues.forEach((issue) => console.log(`     • ${issue}`));
      console.log('');
    }
  } else {
    console.log('   All products passed validation.\n');
  }

  // ── Step 3: Preview first 2 products ──
  console.log('─'.repeat(66));
  console.log('📋 PREVIEW — First 2 Products (Shopify API payload):');
  console.log('─'.repeat(66));
  const previewCount = Math.min(2, products.length);
  for (let i = 0; i < previewCount; i++) {
    console.log(`\n  Product #${i + 1}:`);
    console.log(JSON.stringify(products[i], null, 2)
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n'));
  }
  console.log('\n' + '─'.repeat(66));

  // ── Dry-run exit ──
  if (DRY_RUN) {
    console.log('\n🔍 Dry-run complete. No products were uploaded.');
    console.log(`   ${products.length} product(s) ready for upload.`);
    if (validationErrors.length > 0) {
      console.log(`   ⚠️  ${validationErrors.length} product(s) have validation warnings.`);
    }
    console.log('   Remove --dry-run to upload for real.\n');
    return;
  }

  // ── Step 4: Upload products ──
  console.log(`\n🚀 Uploading ${products.length} product(s) to ${storeDomain}...\n`);

  let created = 0;
  let failed = 0;
  const failures = [];

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const progress = `[${String(i + 1).padStart(String(products.length).length)}/${products.length}]`;

    try {
      const result = await createProduct(product);
      const variantCount = result.variants?.length || 0;
      console.log(
        `  ✅ ${progress} Created: "${result.title}"` +
        `  (ID: ${result.id}, ${variantCount} variant${variantCount !== 1 ? 's' : ''})`
      );
      created++;
    } catch (error) {
      // Extract the most useful error message
      let errorMsg;
      if (error.response?.body?.errors) {
        const errs = error.response.body.errors;
        errorMsg = typeof errs === 'string' ? errs : JSON.stringify(errs);
      } else {
        errorMsg = error.message;
      }

      console.error(`  ❌ ${progress} Failed:  "${product.title}" — ${errorMsg}`);
      failures.push({ title: product.title, handle: product.handle, error: errorMsg });
      failed++;
    }

    // Rate limiting: 1-second pause between requests (skip after last)
    if (i < products.length - 1) {
      await delay(RATE_LIMIT_DELAY_MS);
    }
  }

  // ── Step 5: Summary ──
  console.log('\n' + '═'.repeat(66));
  console.log('  📊 Upload Summary');
  console.log('═'.repeat(66));
  console.log(`  ✅ Created:   ${created}`);
  console.log(`  ❌ Failed:    ${failed}`);
  console.log(`  📦 Total:     ${products.length}`);

  if (failures.length > 0) {
    console.log('\n  ⚠️  Failed products:');
    for (const f of failures) {
      console.log(`     • "${f.title}" (${f.handle})`);
      console.log(`       Error: ${f.error}`);
    }
  }

  console.log('\n✨ Done!\n');
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((error) => {
  console.error('\n💥 Fatal error:', error.message);
  if (error.response?.body) {
    console.error('   Response:', JSON.stringify(error.response.body, null, 2));
  }
  process.exit(1);
});
