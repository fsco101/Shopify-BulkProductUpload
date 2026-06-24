# 🛍️ Shopify Product Bulk Uploader
 
 First, setup .env file, create .env file then copy and paste the below credentials.
 # Shopify Store Settings
SHOPIFY_STORE_URL=xxxxxxxxxxxxxxx (replace with real Store Url)

# Custom App Client Credentials
SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxx (replace with real Client Id)
SHOPIFY_CLIENT_SECRET=xxxxxxxxxxxx (replace with real Client Secret)
 
 
 
  Reads products from a local CSV file and uploads them to your Shopify (upload-product.js)
 *  store via the Admin REST API. Supports multi-variant products, images,
 *  tags, and automatic handle generation.
 *
 *  Usage:
 *    node upload-products.js              — Upload all products
 *    node upload-products.js --dry-run    — Parse & validate only (no API calls)
 *
 * ─── HOW TO GET YOUR ADMIN API ACCESS TOKEN ─────────────────────────────
 *
 *  1. Log in to your Shopify Admin (https://your-store.myshopify.com/admin)
 *  2. Go to  Settings → Apps and sales channels
 *  3. Click "Develop apps"
 *       → If prompted, click "Allow custom app development" first
 *  4. Click "Create an app" → name it (e.g. "Product Uploader")
 *  5. Go to  Configuration → Admin API integration
 *  6. Enable these scopes:
 *       ✔ write_products
 *       ✔ read_products
 *  7. Click "Save" → then the "Install app" button
 *  8. Under "API credentials", reveal and copy the Admin API access token
 *
 *  ⚠️  The token is shown ONLY ONCE — store it in your .env file immediately.





Upload products from a local CSV file to your Shopify store using the Admin REST API.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure credentials
cp .env.example .env
# Edit .env with your store URL and Admin API access token

# 3. Dry-run (parse & validate only — no API calls)
npm run dry-run

# 4. Upload for real
npm run upload
```

## Project Structure

```
├── upload-products.js    ← Main script
├── data/
│   └── products.csv      ← Your product CSV (sample included)
├── package.json
├── .env.example           ← Env var template with setup instructions
├── .env                   ← Your actual credentials (git-ignored)
└── .gitignore
```

## CSV Format

The CSV follows the [standard Shopify product CSV format](https://help.shopify.com/en/manual/products/import-export/using-csv). Key columns:

| CSV Column | Maps To | Notes |
|---|---|---|
| `Handle` | `product.handle` | URL slug; auto-generated from Title if missing |
| `Title` | `product.title` | Required on the first row per product |
| `Body (HTML)` | `product.body_html` | Supports HTML |
| `Vendor` | `product.vendor` | Brand name |
| `Type` | `product.product_type` | Product category |
| `Tags` | `product.tags` | Comma-separated string |
| `Status` | `product.status` | `active`, `draft`, or `archived` |
| `Variant Price` | `variants[].price` | Required per variant |
| `Variant SKU` | `variants[].sku` | |
| `Image Src` | `images[].src` | Full URL to the image |
| `Option1 Name/Value` | `options[]` / `variants[].option1` | Up to 3 options |

### Multi-variant products

Multiple CSV rows with the **same Handle** are grouped into one product. The first row carries product-level data; subsequent rows add variants:

```csv
Handle,Title,Vendor,Option1 Name,Option1 Value,Variant Price,Image Src
my-tshirt,Cool T-Shirt,MyBrand,Size,Small,29.99,https://…/small.jpg
my-tshirt,,,Size,Large,34.99,https://…/large.jpg
```

## Getting Your API Token

1. Shopify Admin → **Settings → Apps and sales channels**
2. Click **Develop apps** → **Create an app**
3. Configure Admin API scopes: enable `write_products` and `read_products`
4. **Install app** → copy the Admin API access token
5. Paste it into `.env` as `SHOPIFY_ADMIN_API_ACCESS_TOKEN`

> ⚠️ The token is shown only once — save it immediately.

## Features

- ✅ Parses standard Shopify product CSVs
- ✅ Auto-generates handles from titles when missing
- ✅ Groups multi-row variants under a single product
- ✅ Maps image URLs to the product images array
- ✅ Validates against required Shopify fields before upload
- ✅ 1-second rate limiting between API calls (avoids 429s)
- ✅ Per-product error handling — failures don't stop the batch
- ✅ `--dry-run` mode for safe previewing
- ✅ Rich console output with progress tracking

 