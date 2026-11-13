# lookOn: virtual try-on for Shopify

Shoppers see a product (earrings, glasses, hats, hair, watches…) on their own photo, made by AI. Stores pay with prepaid credits.

## The three parts
| Part | Where | Who |
| --- | --- | --- |
| **Try-on block** | Product pages (theme app embed) | Shoppers |
| **Merchant admin** | Shopify admin > Apps > lookOn (`/app`) | Each store: credits, texts, product mapping, settings |
| **Super admin** | `/panel` on your server | You: all stores, pricing, payment keys, revenue |

## Credits and payments
- Stores see **credits and images only**: "$100 → 5,000 credits = 500 images". By default **1 image = 10 credits**.
- **Credit logic** (super admin > Credit logic), all editable:
  - *Credit packs* (default): $10 = 500, $20 = 1,000, $50 = 2,500, $100 = 5,000 credits. Add, remove or rename packs and mark one "Most chosen".
  - *Any amount*: stores choose an amount at a rate, e.g. 50 credits per $1.
  - Credits per image, **smallest purchase in credits** (smaller packs are hidden), welcome credits, low-credit warning.
  - **Your cost and profit**: cost per image (e.g. ₹10), the cost currency and the exchange rate (e.g. 1 USD = 94 INR). A package table shows credits, images, revenue, image cost, gross profit and margin for every pack ($100 → ₹9,400 − ₹5,000 = ₹4,400, 46.8%), before payment fees, taxes and other expenses.
- Each successful preview uses the credits per image. Failed previews and retries are free for the store. With no credits, no AI call is made.
- **Test and live mode** switch, separate test/live keys, a "Test payment" button in test mode; any store can be put in test or live on its own; test payments are never revenue.
- Per store: bonus credits % on every purchase, mode, ways to pay, and add or remove credits.
- **Revenue** (super admin > Payments): per store and in total, in your cost currency: revenue, image cost so far, gross profit, and margin if every sold credit is used.

## Shopper limits (merchant > Settings)
- **Free previews**, then ask for **email**, **sign-in to the store account**, or **either**. Emails are saved for the merchant, with an optional "email me offers" box.
- **Previews per product** and **previews per day**, per shopper.
- A shopper is recognised by a random id in their browser, the email they gave, and their store account when signed in. Once they give an email, every browser they used with it counts as the same shopper.
- Limits are checked before any AI call. Note: these are shopper-experience limits, not hard security; a determined shopper can clear their browser and use a new email.

## Activity (merchant > Activity)
- Every try-on attempt: time, product and variant, shopper (email, signed-in customer, or anonymous visitor), device, OS, browser, country, result (preview made, failed, stopped by a rule, and why) and credits used.
- Filters: period, product, result, shopper type, device, search. Summary: previews, shoppers, emails collected, credits used, failed, stopped, most-tried products.
- **Shoppers** view: one row per shopper with previews, products tried, offers consent, first and last seen.
- **Download CSV** of either view. Shopper photos are never stored.

### Payment methods
| Method | How it works | Set up |
| --- | --- | --- |
| **Shopify Billing** | One-time charge on the merchant's Shopify bill (`appPurchaseOneTimeCreate`). | Switch on in the panel. Test mode makes test charges; live mode makes real ones. |
| **Stripe** | Stripe Checkout page; credits added by the return page and the webhook. | Test and live secret keys + webhook secrets in the panel; webhook `APP_URL/webhooks/stripe` for `checkout.session.completed` and `checkout.session.expired`. |
| **Razorpay** | Hosted lookOn pay page with Razorpay Checkout; payment signature verified. | Key ID, key secret, webhook secret in the panel; webhook `APP_URL/webhooks/razorpay` for `order.paid` and `payment.failed`. |

**Important (Shopify rule):** apps listed on the Shopify App Store must charge through Shopify Billing. Tick **"Listed on the Shopify App Store"** in the panel and only Shopify Billing is offered. Stripe and Razorpay are for stores you install directly (unlisted app or custom app). A payment is credited exactly once, whether the webhook or the return page confirms it first.

## Merchant admin (inside Shopify)
- **Credits**: balance, ≈ try-ons left, add credits with a live "you pay / you get" preview, payment and credit history, low/empty banners.
- **Texts**: every line the shopper sees (heading, buttons, consent, progress and error messages, photo-check messages, out-of-credits text). Blank = default.
- **Products**: map each Shopify *product type* to a try-on type (e.g. "Jhumka" → earrings), or set one product's type, or mark it "Not try-on"; switch the block on/off per product. Order used: metafield `custom.tryon_category` → product choice → product-type rule → automatic detection (type, tags, title; optional photo recognition) → optional general preview.
- **Settings**: what happens at zero credit (message or hide); general preview for products lookOn cannot recognise (off by default).


Works for **any Shopify store and any wearable product**: wigs and hair, hats, beards, glasses, earrings, necklaces, headbands, scarves, makeup shades. Nothing is typed in by hand.

## How it works
1. The theme block sits on the product page. It sends the **store**, the **product** and the **variant the shopper has selected** (it notices when the shopper changes colour or size).
2. The server reads that product from the store (public storefront data, or the Admin API once the store has installed the app), works out the **category** from the product type, tags and title, and picks the **photo of the selected variant**.
3. The shopper's photo and the product photo go to the AI together: "put exactly this product on this person". The result comes back and is shown whole.
4. Products that are not wearable (oil, gift cards, stands, cases) get no try-on button.

Product data stays current by itself: webhooks update the catalogue when the merchant edits, adds or deletes a product, and a product is re-read live when it is older than 10 minutes.

## What keeps results accurate
- **Product photo clean-up:** plain borders are removed and the item is centred on a square, so the AI sees the product, not a mostly-empty photo.
- **Right photo for the variant:** the variant's own photo; if it has none, the photo whose file name or alt text mentions the selected colour or option (e.g. `burgundy`); only then the main photo. The selected options are also written into the prompt.
- **No copying the model:** the prompt tells the AI to take only the product from the product photo, never the model's face or body.
- **No stretching:** the result is requested in the closest allowed shape to the shopper's photo and trimmed (never stretched) to match it exactly. The prompt forbids warping the face or body.
- **Bad results are caught:** a blank picture, or the photo handed back unchanged (hair, hats and scarves: overall; small items like earrings, watches and glasses: no visible change anywhere), is retried automatically (`TRYON_RETRIES`, default 1). If it still fails the shopper gets a clear message instead of a bad image. Retries use extra AI calls.
- Needs the `sharp` package (installed by `npm install`); if it cannot run, these steps are skipped and previews still work.

## Checking the photo before spending an AI call
Each product type says what the photo must show (`needs` in `lib/categories.js`): a face (hats, hair, glasses, beards, makeup, headbands), ears (earrings), neck and shoulders (necklaces, scarves), or a wrist / hand (watches, bracelets, rings). The block checks this **on the shopper's device** (MediaPipe face and hand detection, free) before anything is sent:
- no face found, face too small, ears cut off, no room for a neck, no hand found, wrist or fingers cut off: the shopper sees a plain explanation and **no AI call is made**;
- a **"Try anyway with this photo"** button is shown, in case the checker was wrong (for example a turned head);
- if the detector cannot load (blocked network), nothing is blocked and the preview goes ahead.
It cannot see whether hair covers an ear or a sleeve covers a wrist; the per-product photo hint and the server's retry cover those.

## Recognising products from their photo (optional)
Products are normally placed by their type, tags and title. Products those words cannot place (for example "Aurora Piece No. 7") can be recognised from the product photo: set `VISION_CLASSIFY=1`. The server then asks a vision model, **once per product** (the answer, including "not wearable", is saved and reused), and only for products the words could not place. Unclear answers count as "not wearable"; it never guesses. Uses Gemini (`gemini-2.5-flash`) if `GEMINI_API_KEY` is set, otherwise Cloudflare (`@cf/llava-hf/llava-1.5-7b-hf`); override with `VISION_ENGINE` and `VISION_MODEL`. The Cloudflare request format was written from its published API and has not been tested live; check one product after switching it on.

## Keeping the shopper's real face
The AI sometimes subtly changes the face. For products that do not cover the face (hair, hats, earrings, necklaces, scarves, headbands), the block finds the face in the shopper's photo and in the AI picture (MediaPipe, in the browser), lines them up, and puts the **real face (eyebrows down) back on top** with a soft edge and matched skin tone. Hair, hat and background stay AI-made.
- The real face is **warped piece by piece onto the AI's face shape**, so the small changes the AI makes to the chin, nose position or pose when it draws new hair do not matter. Only when the AI draws a completely different face or pose does it fall back to the plain AI picture, with a message that says why (face not found in the photo, or faces too different).
- The shopper can untick "Keep my real face" to see the plain AI picture.
- Not used for beards, glasses and makeup (they change the face), or for watches and rings (no face needed). Set per category with `keepFace` in `lib/categories.js`.
- The face library loads from jsDelivr/Google the first time (a few MB); if it cannot load, the plain AI picture is used.

## Categories
hair (wig, extensions, bundles, braids, twists), hat, beard, glasses, earrings, necklace, **wrist (watches, bracelets, bangles)**, **ring**, headwear (headbands, clips, scrunchies), scarf, makeup. Wrist and ring need a photo of a hand, not a face; each category has a `photoHint` that the block shows to the shopper before they upload. Add or tune them in `lib/categories.js`: each has `include` words, `exclude` words and a `placement` sentence for the AI. A merchant can force a category on one product with the metafield `custom.tryon_category` (e.g. `hat`).

## Set up
### 1. Run the server
```bash
npm install
cp .env.example .env     # fill in the engine keys; see the file for every setting
npm test                 # 74 checks with fake Shopify / AI / Stripe / Razorpay, never calls the real ones
npm start
```
Needs Node 20.12+. It keeps its data in `data/db.json`, so host it where files persist (Render, Railway, Fly, a VPS). On Vercel the files are not kept: set `DATA_FILE=memory` (fine for one store) or use `MONGODB_URI`. Do not add rewrites to `vercel.json`: Vercel detects Express and sends every path to `server.js` itself; a rewrite makes the app see the wrong path.

**Choose the AI engine with one setting:**

| `TRYON_ENGINE` | Good for | Trade-off |
| --- | --- | --- |
| `gemini` | Best match to the real product; accepts the full-size photo | Paid per preview |
| `cloudflare` | Free daily allowance | Input photos under 512 px, so softer and less exact |

If you set only one engine's keys you do not need `TRYON_ENGINE`.

### 2. One store only (fastest)
You still create a (free) Shopify app, because the product-page block is a theme *app* extension and that is how Shopify delivers it to your theme. But the server does **not** need the Shopify keys: leave `SHOPIFY_*` unset, set `ALLOWED_SHOPS=your-store.myshopify.com`, and the server reads your products from the public storefront. Steps: create the app, put its `client_id` and your server URL in `shopify-app/shopify.app.toml` and the server URL in the block file, run `npx shopify app deploy`, install the app on your store, then add **lookOn try-on** to the product page in the theme editor (Add block > Apps).

### 3. Many stores (a real Shopify app)
1. Create the app in the Shopify Dev Dashboard. Put its `client_id` and your server URL in `shopify-app/shopify.app.toml`.
2. Set `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `APP_URL` on the server.
3. In `shopify-app/extensions/product-tryon/blocks/product-tryon.liquid`, replace `https://YOUR-TRYON-SERVER.example.com` with your server URL once, so merchants never type it.
4. `npx shopify app deploy`, then install the app on a store. Install registers the store, saves its (encrypted) token, subscribes to product webhooks and pulls the whole catalogue.
5. The merchant adds **lookOn try-on** to the product template in the theme editor.

Only stores that installed the app can use the server when the Shopify app is configured.

### 4. Admin panels (multi-store accounts)
The platform panel is available at `/panel`. Set `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, and a long random `PLATFORM_SESSION_SECRET` on the server before launch. The super admin signs in there, creates purchaser accounts with a temporary password, and can suspend, restore, or remove those accounts. Purchasers sign in at the same address and connect their own Shopify stores; the OAuth flow links each store and its catalog to that purchaser. A store cannot be linked to a second purchaser while it is already assigned. Stores installed before purchaser accounts existed appear as unassigned to the super admin; choose an account in that store’s owner selector to transfer its existing synced catalog without another Shopify authorization.

Stores that install from Shopify get their account automatically. There is no email delivery or purchaser password reset yet. The super admin must deliver the temporary password securely. On a purchaser account removal, the Shopify connection and catalog are retained but unassigned, so the super admin can still see them. 

The panel uses the configured app secret to sign sessions if `PLATFORM_SESSION_SECRET` is omitted. For deployment, set a separate random secret and retain it across restarts. Persistent multi-instance deployments need MongoDB; the default JSON store requires persistent disk.

## Which websites may call the server (CORS)
By default any site can. When you set `ALLOWED_SHOPS`, the pages of those stores on `https://<shop>.myshopify.com` are allowed automatically. If your storefront shows on its own domain (for example `radrasa.com`), add it: `CORS_ORIGINS=https://radrasa.com,https://www.radrasa.com`. A site that is not allowed shows "Failed to fetch" in the browser console. No need to edit the code.

## Checking a store
With `ADMIN_SECRET` set:
```bash
curl -X POST $URL/admin/sync    -H "Authorization: Bearer $ADMIN_SECRET" -H "content-type: application/json" -d '{"shop":"my-store.myshopify.com"}'
curl "$URL/admin/catalog?shop=my-store.myshopify.com" -H "Authorization: Bearer $ADMIN_SECRET"
```
The second call lists every product and whether it was recognised as try-on ready (and as which category), so you can spot misdetected ones and fix them with the metafield.

## Safety built in
- The shop must be a real `*.myshopify.com` name and the handle a plain handle; product photos are only fetched from `https://cdn.shopify.com` or the shop itself (no arbitrary URLs).
- Webhooks and install links are signature-checked; install uses a signed, expiring state tied to a cookie; store tokens are encrypted at rest.
- The browser never sends prompt text. Product titles and options are cleaned before they reach the AI.
- Shoppers must tick a consent box; photos are not stored. Per-visitor, per-store and global daily limits protect your bill.

## Known limits (read before going live)
- **Accuracy depends on the product photo.** A clear photo of the item on a plain background works best. If a variant has no photo of its own, the product's main photo is used and the selected colour/size is passed as text, which is less exact.
- **Hair products are the hardest** (length, hairline, texture). Hats, glasses and beards copy a reference photo much more reliably.
- **Cloudflare multi-image input** (`input_image_1` for the product) follows Cloudflare's FLUX.2 multi-reference format; confirm it with one live request before launch. Gemini uses the same request format as your existing tool.
- Rate limits and daily counts are in memory; use Redis if you run several servers. Credits and payments are stored with the rest of the data (JSON file or MongoDB); use MongoDB for more than one server.
- Product sync uses Shopify's REST Admin API. Shopify asks new public apps to use the GraphQL Admin API; move `lib/products.js` to GraphQL before submitting to the App Store.
- Low-balance warnings show inside the app; no emails are sent yet.
- Only public (non-password-protected) stores can be read without the app; the Admin API token covers the rest.
