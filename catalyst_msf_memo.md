# Catalyst MSF: one app, many channels, subpath routing

How to serve multiple BigCommerce storefront channels from a **single** Catalyst app,
with each channel on its own URL subpath. Examples use two channels — NZ (`1889993`) and AU
(`1889990`) — but nothing here is specific to that pair.

## Key concepts

- **Store:** one catalog, customer base and set of API credentials.
- **Channel (storefront):** a sales channel within the store. Each has its own product/category
  assignments, languages, currencies, site URL and checkout domain. MSF = multi-storefront.
- **Storefront GraphQL API:** what Catalyst reads from, one endpoint per channel
  (`store-{hash}-{channelId}.mybigcommerce.com/graphql`). Carts are bound to the channel that
  created them.
- **Locale:** a language on a channel, with an optional subfolder path. Catalyst's only way to
  map a URL subpath to a channel.
- **Currency assignment:** per channel. Separately, the store has **one** default currency.
- **Makeswift:** the visual page builder. It has its own locale settings per site.

## tl;dr

One Catalyst app serves several BigCommerce channels by treating each region as a locale: the URL subpath picks the locale, and the locale picks the channel.

- Config channel (BIGCOMMERCE_CHANNEL_ID, NZ 1889993) carries every region's language and subfolder path: en-NZ → nz (default), en-AU → au.
- Other channels carry only their own language (AU: en-AU). Catalyst ignores them.
- channels.config.ts maps each locale to its channel: en-NZ → 1889993, en-AU → 1889990.
- / has no storefront; it redirects to a region using the cookie, then Accept-Language, then the default (/nz).
- Locales are read from BigCommerce at runtime (cached 5 minutes), so control-panel changes need no redeploy.
- Each channel gets its own cart and its own currency (AU = AUD, NZ = NZD). Switching region switches both.
- Makeswift needs the same locales; its default locale must match the BigCommerce default (en-NZ).
- Domains: BigCommerce allows one site URL per channel, so the config channel owns the real domain (www.catalyst-msf.store) and every other channel gets a redirect-only host (au.catalyst-msf.store → www, via Vercel). Each channel has its own checkout domain.
- Custom code on top of stock: the channel mapping, with-locale-aliases.ts (the Makeswift builder previews at /en-AU rather than /au), getSiteBaseUrl() (canonical/hreflang always use the config channel's domain), getPreferredCurrencyCode() (falls back to the channel's currency), the empty en-AU/en-NZ message files, and a backport of upstream PR #3244 (per-channel carts) until it ships.
- Upgrade with `pnpm catalyst upgrade`, one minor version at a time (§10).

## 1. First principle: a "locale" is your region primitive

Catalyst has exactly one mechanism for mapping a URL subpath to a channel: **the
locale**. There is no separate "region" or "market" concept. So a region becomes a
locale, and `channels.config.ts` maps it to a channel.

```ts
// channels.config.ts
const localeToChannelsMappings: Record<string, string> = {
  'en-NZ': '1889993',
  'en-AU': '1889990',
};
```

The word is a poor fit when regions share a language — AU and NZ are both English —
but it is the correct term for Next.js, next-intl, and BigCommerce alike. Use region
subtags (`en-NZ`, `en-AU`) rather than inventing codes; BigCommerce validates against
a fixed supported-locale list.

**Constraints that follow from this choice:**

| Constraint | Consequence |
| :-- | :-- |
| One locale maps to one channel only | Two regions cannot share a locale code |
| Max 5 locales per storefront | Max 5 regions |
| Catalyst reads locales from **one** channel — the one in `BIGCOMMERCE_CHANNEL_ID` | That channel is the "config channel" and must carry **every** region's language and path. Other channels' languages are ignored by Catalyst |

*This repo:* the config channel is NZ `1889993`, carrying `en-NZ` (default, path `nz`) and
`en-AU` (path `au`). The AU channel `1889990` carries only `en-AU` (path `au`) — not read by
Catalyst, but it keeps the control panel mirroring the storefront and is the language BigCommerce
serves catalog translations in when AU requests arrive with `Accept-Language: en-AU`.

This is the documented pattern: *"you only need to add locales to the Catalyst channel you
created as it is the default channel for your Catalyst app, not both channels you are using."*
Giving each channel only its own language breaks routing — the config channel then reports a
single locale and every other region silently disappears within minutes.

## 2. The data flow

Locales are read from the **config channel at runtime**, KV-cached for 5 minutes
(stale-while-revalidate):

```
proxies/with-intl.ts ──► i18n/locale-config.ts (getLocaleRoutingForProxy) ──LocaleSettingsQuery──► BigCommerce
                                   │  KV cache, 5 min
                                   ▼
                  i18n/locale-routing.ts (deriveLocaleRouting)
                     locales · defaultLocale · prefixes · rootLocale
                                   │
            forwarded to the render in the x-bc-locale-routing header (getLocaleRouting)
```

`build-config/build-config.json` (written at build/dev start) now holds only site URLs
(`vanityUrl`, checkout, CDN). Site URL changes still need a redeploy.

`prefixes` is the single source of truth for subpaths:

| Consumer | Uses `prefixes` for |
| :-- | :-- |
| `i18n/locale-routing.ts` (`createRouting`) | next-intl routing |
| `proxies/with-locale-aliases.ts` | mapping raw-code URLs (`/en-AU/...`) onto the real prefix |
| `proxies/with-routes.ts` | stripping the prefix before asking BigCommerce to resolve a slug |
| `lib/seo/canonical.ts` (`getLocalePrefix`) | canonical + hreflang URLs |

## 3. Per-request: the proxy chain

`proxy.ts` composes ordered middleware. Order is load-bearing:

```
withUcpProxy → withAuth → withMakeswift → withLocaleAliases → withIntl
             → withAnalyticsCookies → withChannelId → withGraphqlProxy → withRoutes
```

1. **`withMakeswift`** flags builder (draft-mode) requests and disables next-intl's
   cookie/`Accept-Language` detection for them.
2. **`withLocaleAliases`** turns `/{localeCode}/...` into the real prefix — rewrite for
   builder requests, 308 for everyone else (see §6).
3. **`withIntl`** runs the next-intl middleware, resolves the locale, sets `x-bc-locale`.
4. **`withChannelId`** calls `getChannelIdFromLocale()`, sets `x-bc-channel-id`.
5. **`withRoutes`** asks BigCommerce to resolve the path *on that channel*, then
   rewrites to the internal `/[locale]/...` route.

So the subpath determines the locale, the locale determines the channel, and the
channel determines what a slug even means. The same slug legitimately resolves to
different entities per channel — `/au/shop-all` → `category/24`,
`/nz/shop-all` → `category/33` — and 404s where a category isn't assigned.

**Locale resolution order** (next-intl, `resolveLocale.js`) — worth knowing precisely:

```
1. locale prefix in the URL      (deep links, crawlers)
2. NEXT_LOCALE cookie            (explicit user choice; written by the header switcher)
3. Accept-Language negotiation
4. routing.defaultLocale         (fallback)
```

Step 3 is weak for same-language regions: `en-AU`/`en-NZ` only match on an exact
region subtag, so the common `en-US,en;q=0.9` falls through to step 4. A `NEXT_LOCALE`
cookie holding a code that is no longer in `locales` (e.g. a stale `en`) is ignored, not
an error.

## 4. Server-side data fetching

Requests go to a **channel-specific endpoint**:

```
https://store-{hash}-{channelId}.mybigcommerce.com/graphql
```

`client/index.ts` resolves the channel per request via a `getChannelId` callback that
calls next-intl's `getLocale()`. When `getLocale()` is unavailable it falls back to
`BIGCOMMERCE_CHANNEL_ID`. That happens in more places than you'd expect:

- `next.config.ts` resolution · API routes · proxies
- `lib/kv/keys.ts` — default KV cache namespace
- `auth/index.ts` — when a JWT carries no `channel_id`

**Gotcha:** if your default *region* isn't the channel in `BIGCOMMERCE_CHANNEL_ID`,
"unresolved locale" silently means a different channel than "default locale" does.
Pick one and know which paths use which. *This repo avoids it:* the config channel
(`BIGCOMMERCE_CHANNEL_ID`) is NZ `1889993` and its default language is `en-NZ`, so
schema generation, locale config, the `/` redirect, sitemap, robots,
favicon and every fallback above all mean NZ. The build-config `vanityUrl` (used for
login and wishlist redirects) is NZ's too.

**Single-channel by design:** `sitemap.xml`, `robots.txt` and `favicon.ico` routes all
call `getChannelIdFromLocale(defaultLocale)` — they reflect the default region only.
Multi-region sitemaps need work. `checkout/route.ts` *is* channel-aware; each channel
has its own checkout URL.

**Domains: one storefront domain, but one site URL per channel.** BigCommerce won't let
two channels share a site URL. So the config channel owns the real domain
(`www.catalyst-msf.store`, checkout `checkout.catalyst-msf.store`), and every other channel
gets a redirect-only host (AU: `au.catalyst-msf.store` → 308 to `www` in Vercel, path kept;
checkout `checkout.au.catalyst-msf.store`). BigCommerce's links back from checkout and
emails (site URL + site routes, e.g. "Edit cart" → `au.…/cart/`) land on `www` and pick the
region from the `NEXT_LOCALE` cookie. Prefixing each site's routes (`/au/cart`, …) would make
them cookie-independent — not done yet.

**Canonical/hreflang use the config channel's URL.** Stock Catalyst builds absolute URLs
from the *requesting* channel's site URL, which would make AU pages declare the
redirect-only `au.` host and make hreflang disagree between regions. `getSiteBaseUrl()` in
`lib/seo/canonical.ts` (also used for `metadataBase` in `app/[locale]/layout.tsx`) uses the
config channel's `vanityUrl` from the build snapshot for every region instead. Frozen at
build time, so site URL changes need a redeploy.

**Carts are per channel.** A cart only exists on the channel that created it. The session
stores `cartIds` keyed by channel (`lib/cart/`, `lib/channel.ts`, backported from upstream PR
#3244), so each region keeps its own cart across switches. `switchLocale` skips cart locale
sync when the target locale is on another channel.

**Currency is per channel.** Storefront GraphQL uses the **store** default currency when a
request names none, even on a channel that doesn't enable it: AU would price in NZD, and cart
creation fails with "Currency not found". `getPreferredCurrencyCode()` (`lib/currency.ts`)
therefore falls back to the channel's own `defaultCurrency`, and ignores a `currencyCode`
cookie the channel doesn't offer. Set each channel's currencies with
`PUT /v3/channels/{id}/currency-assignments`. Toggling a store currency's visibility can
silently change channel assignments, so re-check them afterwards.

## 5. Gotchas that cost real time

**Set each language's subfolder path in the control panel, on the config channel.**
`i18n/locale-routing.ts` only assigns a prefix when a path is set, so an empty path means
next-intl silently uses the raw locale code as the segment (`/en-AU`, not `/au`), and
also changes who owns `/` (§7). The GraphQL Admin API's `addLocale`/`updateLocale` have
**no path field** — the control panel is the place. Changes reach the app within ~5 minutes
(locale cache). Verify what Catalyst will see:

```sh
curl -s "https://store-$BIGCOMMERCE_STORE_HASH-$BIGCOMMERCE_CHANNEL_ID.mybigcommerce.com/graphql" \
  -H "Authorization: Bearer $BIGCOMMERCE_STOREFRONT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ site { settings { locales { code isDefault path } } } }"}'
```

**Stray languages on the config channel become served locales.** Any language there
(e.g. a leftover bare `en`) turns into a route and, if it has no path, can claim `/`.
Remove it in the control panel rather than filtering it in app code.

**BigCommerce tolerates an unknown `Accept-Language`.** The client sends the locale code
per request; a channel without that language falls back to its default without error.

**Every served locale needs `messages/{locale}.json`.** `i18n/request.ts` imports
it and 404s if absent, as it does for any locale not in the locale routing. For a region
that shares a language, `{}` is correct — the file is deep-merged over `en`, inheriting
every string. `messages/en.json` must stay even though `en` is not a served locale: it is
the fallback the merge starts from.

**A dev-only infinite reload loop is a stale Turbopack cache, not routing.** Symptom: a
page reloads forever in the browser but `curl` shows a plain 404/200 with no redirect
chain, and the dev log repeats `FATAL: ... Failed to write app endpoint ... Next.js package
not found`. The HMR client reloads on every panic. `rm -rf .next` and restart. Check this
before reading a single line of proxy code — it cost an afternoon.

**Storefront API tokens can be channel-scoped.** Tokens minted via
`POST /v3/storefront/api-token` accept a `channel_id`. A store-scoped token works
across all channels; a channel-scoped one won't. Test yours against a second channel
before debugging anything else.

**The KV route cache is keyed by `(pathname, channelId)`** and served
stale-while-revalidate. Since `clearLocaleFromPath` strips the prefix first, the root
URL and the prefix for the *same* channel share a key. After catalog changes, expect
one stale 404; re-request before investigating.

**`TRAILING_SLASH`** affects route comparison (`normalizeForCompare`) and canonical
URLs. BigCommerce generates trailing slashes by default.

## 6. Makeswift concerns

Makeswift is a **separate** localization system that must be configured to match. It
is keyed per *site*, not per channel.

- **A homepage 404 on every locale means the site has no published pages**, not a
  locale problem. Check before anything else:
  `curl -H "X-API-Key: $MAKESWIFT_SITE_API_KEY" "https://api.makeswift.com/v5/pages?version=ref:live"`
  — an empty `data` array is your answer. Draft pages need a preview token and won't show.
- **Verify the key against the running host**, not the dashboard:
  `/api/makeswift/manifest?secret=<key>` returns 200 for the right key, 401 otherwise.
  The builder's *Site ID* is not used by the app; only the Site API key is.
- **Add the same locales in Makeswift** that you added in the control panel. Missing
  locales are the next most common cause of a mysterious homepage 404.
- **The builder ignores custom prefixes.** Makeswift previews localized pages at
  `/{localeCode}/...` (`/en-AU/shop-all`), never at `/au/...`. `proxies/with-locale-aliases.ts`
  (before `withIntl` in `proxy.ts`) maps the raw code onto the real prefix: draft-mode
  requests are rewritten in place, public requests get a 308 to the canonical URL. Draft
  mode is detected via `unstable_isDraftModeRequest` — the `makeswift-preview-token` query
  param or the `__prerender_bypass` + `makeswift-site-version` cookies. (The similarly named
  `makeswiftRewritePreviewToken` is a different thing: the plugin's rewrite-rule match.)
- **Host URL must be `http://localhost:3000` for local dev** — `next dev` has no TLS, so an
  `https://` host URL fails the TLS handshake before the builder ever reaches the manifest.
- `lib/makeswift/client.ts` → `normalizeLocale()` passes `undefined` for the default
  locale and the raw code otherwise. "Default" here is the **BigCommerce** default locale
  (`en-NZ`), so Makeswift's default-locale content *is* the NZ storefront and `en-AU` must
  exist as a named Makeswift locale. A full Makeswift **Page** with no snapshot for that
  locale calls `notFound()` (`lib/makeswift/page.tsx`). Makeswift **Slots** on
  otherwise-normal pages degrade gracefully — which is why a 404 homepage can sit
  alongside working category and cart pages.
- Creating a second Catalyst storefront also creates a **second Makeswift site**. For
  a single-app multi-channel setup you want **one** Makeswift site with locales inside
  it; ignore or delete the extra one and keep a single `MAKESWIFT_SITE_API_KEY`.
- Regional content genuinely diverges (different merchandising, campaigns, imagery),
  so treat per-locale Makeswift pages as real authoring surface, not duplication.

## 7. What happens at the bare domain — a real decision

`deriveLocaleRouting()` in `i18n/locale-routing.ts` decides who owns `/`:

1. Default locale has no path → it lives at `/`.
2. Else if exactly one non-default locale has no path → that one lives at `/`.
3. Otherwise → **nobody**; next-intl switches to `always` mode and every locale is
   prefixed.

Under rule 3, `/` stops being a page and becomes a **redirect**. Three viable shapes:

| Shape | `/` behaviour | Trade-off |
| :-- | :-- | :-- |
| **A.** Default region at `/`, others prefixed | renders the default region | Stock Catalyst, zero extra code. But `/` *is* a storefront, so geo-redirecting away from it means discarding a rendered page. |
| **B.** All regions prefixed, nothing at `/` | redirects | Clean dispatcher, ideal for a geo/chooser step. Requires `rootLocale` to be `null`, and `/` never renders content. |
| **C.** Neutral locale at `/`, regions prefixed alongside | renders a neutral variant | Both `/au` and `/nz` are real URLs *and* `/` still renders. Costs an extra locale, and `/` duplicates a region's content until a dispatcher replaces it. |

*This repo uses B:* every region is prefixed and `/` only redirects. Both config-channel
languages have a path, so stock `deriveLocaleRouting` sets `rootLocale` to `null` and next-intl runs in
`always` mode — no app code needed. The redirect target is whatever next-intl resolves —
`NEXT_LOCALE` cookie, then `Accept-Language`, then the BigCommerce default (`en-NZ` →
`/nz`). A geolocation or region-chooser step can replace that resolution later without
touching the locale model. `en` is not a BigCommerce language; it remains the message
fallback (`messages/en.json`) only.

**Known rough edge under B:** next-intl's own `Link` response header advertises
`hreflang="x-default"` at the *unprefixed* URL, which now redirects. The page-level
metadata from `lib/seo/canonical.ts` correctly points `x-default` at the default region
(`/nz/...`). Either disable `alternateLinks` in `i18n/locale-routing.ts` or accept the redirecting
header until the dispatcher lands.

**Adding geolocation.** Layer it in front of next-intl rather than replacing the
resolution order — cookie (explicit choice) should still beat GeoIP, and GeoIP should
beat `Accept-Language`. Add a proxy before `withIntl`; `proxies/with-makeswift.ts` is
the precedent, setting `x-bc-disable-locale-detection` to suppress next-intl's own
detection and take over. A manual switcher already exists
(`vibes/soul/primitives/navigation/index.tsx` → `LocaleSwitcher`) and persists via
`NEXT_LOCALE`, so honour that cookie or you'll override the shopper's choice.

Note `syncCookie` writes `NEXT_LOCALE` whenever the resolved locale differs from what
`Accept-Language` alone would give — so region choice becomes sticky after one visit.

## 8. Where to look

| File | Role |
| :-- | :-- |
| `channels.config.ts` | locale → channel map |
| `i18n/locale-config.ts` | runtime locale settings from the config channel (KV-cached) |
| `i18n/locale-routing.ts` | derives `locales`, `defaultLocale`, `prefixes`, `rootLocale`; next-intl routing |
| `i18n/request.ts` | per-locale message loading |
| `proxy.ts` + `proxies/*` | ordered request pipeline |
| `proxies/with-makeswift.ts` | flags builder requests, disables locale detection for them |
| `proxies/with-locale-aliases.ts` | `/en-AU/...` → `/au/...` (rewrite for builder, 308 for public) |
| `proxies/with-channel-id.ts` | sets `x-bc-channel-id` |
| `proxies/with-routes.ts` | per-channel slug resolution |
| `client/index.ts` | channel-aware GraphQL client |
| `lib/channel.ts` | current request's channel |
| `lib/cart/` | per-channel cart ids |
| `lib/currency.ts` | per-channel currency fallback |
| `lib/seo/canonical.ts` | canonical + hreflang |
| `lib/makeswift/client.ts` | Makeswift locale normalization |
| `build-config/` | build-time site URL snapshot |

## 9. References

- [Catalyst Multi-Storefront: overview](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-storefront) · [setup](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-storefront/setup)
- [Catalyst multi-language setup](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-language/setup) · [static translations](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/static-translations)
- [Locales configuration (GraphQL Admin API)](https://developer.bigcommerce.com/docs/store-operations/settings/locales) — add/update/delete locales per channel
- [MSF international enhancements](https://developer.bigcommerce.com/docs/store-operations/catalog/msf-international-enhancements/overview) — translating catalog data
- [Multi-storefront overview](https://developer.bigcommerce.com/docs/storefront/multi-storefront)
- [next-intl routing & middleware](https://next-intl.dev/docs/routing) — prefix modes, locale detection
- [Google: managing multi-regional and multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)

## 10. Upgrading Catalyst

`pnpm catalyst upgrade --ref @bigcommerce/catalyst-makeswift@<version>` three-way merges
upstream changes into this repo, using `catalyst.ref` in `package.json` as the base. It needs a
clean git tree; conflicts get standard markers. Work on a branch, `--dry-run` first, go one
minor version at a time, then `pnpm install`, typecheck, `pnpm test` and smoke-test both
regions. When upgrading to the release that includes upstream PR #3244, take upstream's
version of the per-channel cart files.
