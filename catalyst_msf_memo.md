# Catalyst MSF: one app, many channels, subpath routing

How to serve multiple BigCommerce storefront channels from a **single** Catalyst app,
with each channel on its own URL subpath. Examples use two channels — NZ (`1889993`) and AU
(`1889990`).

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

- **A region is a locale.** Catalyst's only way to map a subpath to a channel is the locale, so
  the subpath picks the locale (`/au` → `en-AU`) and `channels.config.ts` maps the locale to a channel.
- **One channel configures routing.** Catalyst reads locales only from `BIGCOMMERCE_CHANNEL_ID`
  (the *config channel*, NZ). It must carry every region's language and subfolder path:
  `en-NZ` → `nz` (default), `en-AU` → `au`. Other channels' languages are ignored.
- **`/` is a dispatcher, not a page.** It redirects to a region using the `NEXT_LOCALE` cookie,
  then `Accept-Language`, then the default (`/nz`).
- **Everything else is per channel:** catalog, slugs, cart, currency and checkout domain.
- **One public domain.** The config channel's site URL is the real domain. Every other channel
  gets a redirect-only host (`au.catalyst-msf.store` → `www`).
- **Makeswift** needs the same locales, and its default must be the BigCommerce default (`en-NZ`).
- Locale changes in the control panel go live within about 5 minutes. Code, message files and
  site URL changes need a deploy.

## Glossary

| Term | Meaning |
| :-- | :-- |
| Store | One catalog, customer base and set of API credentials |
| Channel | A storefront within the store, with its own catalog assignments, languages, currencies, site URL and checkout domain. Storefront GraphQL has one endpoint per channel: `store-{hash}-{channelId}.mybigcommerce.com/graphql` |
| Locale | A language on a channel, with an optional subfolder path |
| Config channel | The channel in `BIGCOMMERCE_CHANNEL_ID`: where Catalyst reads locales from, and what every "no locale" code path falls back to |

## 1. The sandbox: NZ + AU

Everything a region needs, as configured on the sandbox store (www.catalyst-msf.store):

| | NZ `1889993`: config channel, default region | AU `1889990` |
| :-- | :-- | :-- |
| URLs | `/nz/…` | `/au/…` |
| Languages (control panel) | `en-NZ` → path `nz` (default), and `en-AU` → path `au` | `en-AU` → path `au` only |
| `channels.config.ts` | `'en-NZ': '1889993'` | `'en-AU': '1889990'` |
| Message file | `messages/en-NZ.json` = `{}` | `messages/en-AU.json` = `{}` |
| Currency | NZD | AUD |
| Site URL | The real domain: `www.catalyst-msf.store` (GraphQL reports it as the apex, see §8) | `au.catalyst-msf.store`, which Vercel 308-redirects to `www` with the path kept |
| Checkout domain | `checkout.catalyst-msf.store` | `checkout.au.catalyst-msf.store` |
| Makeswift | Default locale (Catalyst sends no locale for NZ) | A named locale `en-AU` on the same site |

NZ carries **both** languages because Catalyst builds its routing from the config channel alone.
AU's own `en-AU` language isn't read by Catalyst. It keeps the control panel consistent, and it is
the language BigCommerce uses for AU's catalog translations. If you give NZ only `en-NZ`, `/au`
disappears within about 5 minutes.

**What happens for a request to `/au/shop-all`:**

1. The NZ channel's locale list maps the `/au` prefix to `en-AU`.
2. `channels.config.ts` maps `en-AU` to channel `1889990`.
3. `shop-all` is resolved on the AU channel (`category/24`; on NZ the same slug is `category/33`).
4. The page is priced in AUD, and the cart is created on the AU channel. It is kept separately
   from any NZ cart in the same session.
5. Checkout runs on `checkout.au.catalyst-msf.store`. Links back to the store ("Edit cart", emails)
   go to `au.catalyst-msf.store/cart/`, which redirects to `www/cart/`. The `NEXT_LOCALE` cookie
   then sends the shopper back to `/au/cart`.

A request with no locale (`/`, API routes, and similar) uses NZ. That works because NZ is both the
config channel and the default language.

**Adding another region means repeating the AU column.** Two things to know first:

- **Deploy the code first.** The mapping and `{}` message file are harmless before the locale
  goes live. A locale that goes live without them 404s (no message file) or silently serves NZ
  (no mapping).
- **Set the subfolder path in the control panel.** The GraphQL Admin API's
  `addLocale`/`updateLocale` have no path field. An empty path makes the URL `/<code>` and can hand
  `/` to that locale (§6).

Constraints:

- A channel can have at most 5 locales, so the setup supports at most 5 regions.
- Codes must be real region subtags (`en-AU`, not `au`), from BigCommerce's fixed list.
- Two regions can't share a code.

Steps:

1. Add the mapping and the message file, then deploy.
2. Set up the new channel as AU is: catalog assignments, its own language and path, currencies
   (`PUT /v3/channels/{id}/currency-assignments`), a redirect-only site URL and a checkout domain.
3. Add the language and path to NZ, the config channel.
4. Add the locale in Makeswift.
5. Add the redirect host in Vercel.
6. Verify. Check locales with the command in §7. Then confirm the new prefix renders in its
   currency, checkout works, and each region keeps its own cart.

## 2. How a request is served

```
withUcpProxy → withAuth → withMakeswift → withLocaleAliases → withIntl
             → withAnalyticsCookies → withChannelId → withGraphqlProxy → withRoutes
```

The order matters:

| Proxy | Does |
| :-- | :-- |
| `withMakeswift` | Flags builder (draft-mode) requests and turns off cookie and `Accept-Language` detection for them |
| `withLocaleAliases` | *Custom.* `/{code}/…` → real prefix (`/en-AU/x` → `/au/x`): rewritten for the builder, 308 for everyone else |
| `withIntl` | Runs next-intl and sets `x-bc-locale`, `x-bc-locale-prefix` and `x-bc-locale-routing` (routing forwarded to the render) |
| `withChannelId` | `getChannelIdFromLocale(x-bc-locale)` → `x-bc-channel-id` |
| `withRoutes` | Strips the prefix, resolves the slug **on that channel**, and rewrites to `/[locale]/…` |

The same slug can mean different things per channel. `/au/shop-all` → `category/24`, while
`/nz/shop-all` → `category/33`. It 404s where the category isn't assigned.

**Locale routing** comes from `i18n/locale-config.ts`, which runs `LocaleSettingsQuery` against
the config channel with a 5-minute KV cache (stale-while-revalidate). `i18n/locale-routing.ts`
turns the result into `locales`, `defaultLocale`, `prefixes` and `rootLocale`. The `prefixes`
map drives next-intl, the aliases, prefix stripping in `withRoutes`, and canonical URLs. The
build snapshot `build-config/build-config.json` holds only site URLs (vanity, checkout, CDN).

**How `/` picks a locale** (next-intl `resolveLocale`):

1. Prefix in the URL.
2. `NEXT_LOCALE` cookie. next-intl writes it on any full-page visit whose locale differs from the
   cookie, not only through the header switcher. Once a shopper opens `/au/…`, AU sticks. A
   cookie holding a code that isn't served is ignored.
3. `Accept-Language`, matched **best-fit**. Any English browser (`en-US`, `en-GB`, `en`) gets
   the *first* English locale in the config channel's list. Today that's `en-NZ`, because
   BigCommerce returns it first. Only an exact `en-AU` picks AU. If you reorder the languages,
   US and UK visitors land somewhere else.
4. The BigCommerce default locale.

**Code paths with no request locale** fall back to `BIGCOMMERCE_CHANNEL_ID`. These are
`next.config.ts`, API routes, proxies, `generateStaticParams`, the default KV namespace
(`lib/kv/keys.ts`), and JWT logins without `channel_id` (`auth/index.ts`). Make the config channel
your default region, as this repo does, so "no locale" and "default locale" mean the same channel.

## 3. Per-channel behaviour

| Concern | Behaviour |
| :-- | :-- |
| **GraphQL** | `client/index.ts` → `lib/channel.ts` `getCurrentChannelId()` resolves the channel from next-intl's locale. It also sends the locale as `Accept-Language`, and a channel without that language falls back to its default without error |
| **Cart** | Carts belong to the channel that created them. The session keeps `cartIds` keyed by channel (`lib/cart/`, a backport of upstream PR #3244), so each region keeps its own cart. `switchLocale` skips the cart locale sync when you switch to another channel |
| **Currency** | If a request names no currency, Storefront GraphQL uses the **store** default, even on channels that don't offer it. AU would then price in NZD, and cart creation fails with "Currency not found". So `lib/currency.ts` `getPreferredCurrencyCode()` falls back to the channel's `defaultCurrency`, and ignores a `currencyCode` cookie the channel doesn't offer. Toggling a store currency's visibility can silently change channel assignments, so re-check them afterwards |
| **Checkout** | `checkout/route.ts` is channel-aware, and each channel has its own checkout domain |
| **SEO** | Stock Catalyst builds canonical URLs from the *requesting* channel's site URL, which would point AU at the redirect-only host. `getSiteBaseUrl()` (`lib/seo/canonical.ts`, also `metadataBase` in `app/[locale]/layout.tsx`) uses the config channel's `vanityUrl` from the build snapshot for every region |
| **Default-region only** | `sitemap.xml`, `robots.txt` and `favicon.ico` call `getChannelIdFromLocale()` with no argument, so they serve the config channel only. Multi-region sitemaps need work |
| **Links back from BigCommerce** | Checkout and email links use each channel's site URL (`au.…/cart/`). They land on `www` unprefixed, so the region comes from `NEXT_LOCALE` |

## 4. Makeswift

Makeswift is a **separate** localization system, keyed per *site* rather than per channel.

- **Use one Makeswift site.** Creating a second Catalyst storefront also creates a second
  Makeswift site. Ignore or delete it, and keep a single `MAKESWIFT_SITE_API_KEY`.
- **Match the locales.** `lib/makeswift/client.ts` `normalizeLocale()` sends `undefined` for the
  BigCommerce default (`en-NZ`) and the raw code otherwise. So Makeswift's default-locale content
  *is* NZ, and `en-AU` must exist as a named locale.
- **Pages vs Slots.** A Makeswift **Page** with no snapshot for the locale calls `notFound()`
  (`lib/makeswift/page.tsx`). **Slots** degrade gracefully. That's why a 404 homepage can sit
  next to working category and cart pages.
- **The builder ignores custom prefixes.** It previews at `/en-AU/…`, and `withLocaleAliases`
  maps that to `/au/…` (§2). Draft mode is detected with `unstable_isDraftModeRequest`, which
  looks for the `makeswift-preview-token` param or the `__prerender_bypass` +
  `makeswift-site-version` cookies.
- **Local dev host URL** must be `http://localhost:3000`. `next dev` has no TLS, so an `https://`
  host fails before the builder reaches the manifest.
- Regional content genuinely differs, so treat per-locale pages as real authoring work rather
  than duplication.

## 5. Custom code on top of stock Catalyst

| Change | Files | Why | Remove when |
| :-- | :-- | :-- | :-- |
| Locale → channel map | `channels.config.ts` | Stock map is empty | Never (it's config) |
| Region message files | `messages/en-AU.json`, `en-NZ.json` (`{}`) | `i18n/request.ts` 404s a locale without one. `{}` deep-merges over `en.json`, which must stay as the base | Never |
| Locale aliases | `proxies/with-locale-aliases.ts`, `proxy.ts` | Builder previews at `/en-AU` | Makeswift honours custom prefixes |
| Single-origin SEO | `lib/seo/canonical.ts`, `app/[locale]/layout.tsx` | One public domain, many site URLs | Upstream supports it |
| Per-channel carts | `lib/cart/*`, `lib/channel.ts`, `auth/*`, `client/index.ts`, login/logout/register/checkout routes | Backport of upstream PR #3244 | Upgrading to the release that includes #3244: take upstream's files |
| Channel currency fallback | `lib/currency.ts` | Store default currency leaks into channels | Upstream fix |
| Cross-channel locale switch | `components/header/_actions/switch-locale.ts` | Syncing the cart locale fails (`LocaleInvalidError`) on another channel's cart | Check against #3244 when it lands |

**Upgrading:** use `pnpm catalyst upgrade --ref @bigcommerce/catalyst-makeswift@<version>`.
It three-way merges from `catalyst.ref` in `package.json` and needs a clean tree. Work on a
branch, run `--dry-run` first, and go one minor version at a time. Afterwards run
`pnpm install`, typecheck and `pnpm test`, then smoke-test every region. Re-check the files in
the table above after each upgrade.

## 6. Decision: what lives at `/`

`deriveLocaleRouting()` (`i18n/locale-routing.ts`) decides who owns `/`:

1. If the default locale has no path, it lives at `/`.
2. Otherwise, if exactly one non-default locale has no path, that one does.
3. Otherwise nobody does. next-intl switches to `always` mode and `/` redirects.

| Shape | `/` | Trade-off |
| :-- | :-- | :-- |
| A. Default region at `/` | Renders the default region | Stock and no code, but geo-redirecting means throwing away a rendered page |
| **B. All prefixed (this repo)** | Redirects | A clean place to add geo or a region chooser. `/` never renders content |
| C. Neutral locale at `/` | Renders a neutral variant | Costs a locale, and duplicates a region until a dispatcher replaces it |

**Adding geolocation:** add a proxy before `withIntl`, using `withMakeswift`'s
`x-bc-disable-locale-detection` as the precedent. Precedence should be cookie (explicit choice)
first, then GeoIP, then `Accept-Language`. The existing `LocaleSwitcher`
(`vibes/soul/primitives/navigation/index.tsx`) writes `NEXT_LOCALE`, so respect that cookie.

## 7. Troubleshooting

| Symptom | Cause / fix |
| :-- | :-- |
| Homepage 404 on **every** locale | The Makeswift site has no *published* pages. `curl -H "X-API-Key: $MAKESWIFT_SITE_API_KEY" "https://api.makeswift.com/v5/pages?version=ref:live"` returns an empty `data` |
| Homepage 404 on **one** locale | The locale is missing in Makeswift |
| Region vanished, or URLs show `/en-AU` instead of `/au` | The config channel lost that language or its path. Check the locales (below) |
| An unexpected locale owns `/` | A stray language (e.g. bare `en`) with no path on the config channel. Remove it in the control panel rather than filtering it in code |
| New region 404s everywhere | `messages/{code}.json` is missing, or the deploy hasn't happened |
| Wrong currency, or "Currency not found" | The channel's currency assignments are wrong |
| 404 right after a catalog change | The KV route cache is keyed by `(path, channel)` and lives 30 minutes (SWR). Logged-in shoppers bypass it. Re-request before investigating |
| Builder: 401, or can't connect | Wrong key: `/api/makeswift/manifest?secret=<key>` should return 200 on the running host (the builder's Site ID isn't used). Local dev needs an `http://` host URL |
| Second channel fails but the config channel works | The storefront token is channel-scoped (`channel_id` on `POST /v3/storefront/api-token`). Use a store-scoped token |
| Dev page reloads forever, but `curl` shows a plain 200/404 | A stale Turbopack cache (the log shows `Failed to write app endpoint … Next.js package not found`). Run `rm -rf .next` and restart. **Check this before reading proxy code** |

What Catalyst sees for locales:

```sh
curl -s "https://store-$BIGCOMMERCE_STORE_HASH-$BIGCOMMERCE_CHANNEL_ID.mybigcommerce.com/graphql" \
  -H "Authorization: Bearer $BIGCOMMERCE_STOREFRONT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"{ site { settings { url { vanityUrl } currency { defaultCurrency } locales { code isDefault path } } } }"}'
```

Swap in another channel ID to check its site URL and default currency.

## 8. Known gaps

- **Canonical host:** NZ's site URL is `https://www.catalyst-msf.store` in the control panel and
  REST (`GET /v3/channels/1889993/site`). Storefront GraphQL `settings.url.vanityUrl` returns it
  without the `www.`, and re-saving it doesn't help. The build snapshot takes its site URL from
  GraphQL, so canonical, hreflang and `og:url` point at the apex, which Vercel 308s to `www`.
- next-intl's `Link` response header puts `x-default` at the unprefixed URL, which redirects.
  The page metadata is correct (`/nz/…`). Either set `alternateLinks: false` in `createRouting`
  or live with it.
- Sitemap and robots cover the default region only (§3).
- BigCommerce site routes (`/cart/`, …) are unprefixed, so links back from checkout rely on the
  cookie. Prefixing them per channel (`/au/cart`) would remove that dependency.
- `TRAILING_SLASH=false` in this repo. It affects route comparison and canonical URLs, and
  BigCommerce generates trailing slashes by default.

## References

- Catalyst: [multi-storefront](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-storefront) · [MSF setup](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-storefront/setup) · [multi-language](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-language/setup) · [static translations](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/static-translations). The docs' own guidance: *"you only need to add locales to the Catalyst channel … not both channels."*
- BigCommerce: [locales (Admin GraphQL)](https://developer.bigcommerce.com/docs/store-operations/settings/locales) · [MSF international enhancements](https://developer.bigcommerce.com/docs/store-operations/catalog/msf-international-enhancements/overview) · [multi-storefront](https://developer.bigcommerce.com/docs/storefront/multi-storefront)
- [next-intl routing](https://next-intl.dev/docs/routing) · [Google: multi-regional sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
