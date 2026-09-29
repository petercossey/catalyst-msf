# Catalyst MSF: one app, many channels, subpath routing

How to serve multiple BigCommerce storefront channels from a **single** Catalyst app,
with each channel on its own URL subpath. Examples use two channels — NZ (`1889993`) and AU (`1889990`) — but nothing here is specific to that pair.

## tl;dr

One Catalyst app serves several BigCommerce channels by treating each region as a locale: the URL subpath picks the locale, and the locale picks the channel.

- Config channel (BIGCOMMERCE_CHANNEL_ID, NZ 1889993) carries every region's language and subfolder path: en-NZ → nz (default), en-AU → au.
- Other channels carry only their own language (AU: en-AU). Catalyst ignores them.
- channels.config.ts maps each locale to its channel: en-NZ → 1889993, en-AU → 1889990.
- / has no storefront; it redirects to a region using the cookie, then Accept-Language, then the default (/nz).
- Locales are read at build time, so a control-panel change only takes effect after restarting dev or redeploying.
- Makeswift needs the same locales; its default locale must match the BigCommerce default (en-NZ).
- Custom code on top of stock is just the channel mapping, with-locale-aliases.ts (the Makeswift builder previews at /en-AU rather than /au), and the empty en-AU/en-NZ message files.

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
single locale and every other region silently disappears on the next build.

## 2. The data flow

Locales are read from BigCommerce **at build time** and frozen into a JSON file:

```
next.config.ts  ──SettingsQuery──►  build-config/writer.ts
                                          │
                              build-config/build-config.json   ← build-time snapshot
                                          │
                                    build-config/reader.ts
                                          │
                                   i18n/locales.ts             ← derives everything
                                    │        │        │
                             prefixes   defaultLocale   rootLocale
```

**Gotcha:** new locales appear immediately in local dev (the config is rewritten on
server start) but **not** on a deployed site until you redeploy. This surprises people.

`i18n/locales.ts` is stock: the subpaths come straight from each language's path on the
config channel in the control panel. It exports four things, and `prefixes` is the important one — it is the single source of
truth for subpaths, consumed in four unrelated places:

| Consumer | Uses `prefixes` for |
| :-- | :-- |
| `i18n/routing.ts` | next-intl `localePrefix` — actual URL routing |
| `proxies/with-locale-aliases.ts` | mapping raw-code URLs (`/en-AU/...`) onto the real prefix |
| `proxies/with-routes.ts` (`clearLocaleFromPath`) | stripping the prefix before asking BigCommerce to resolve a slug |
| `lib/seo/canonical.ts` (`buildLocalizedUrl`) | canonical + hreflang URLs |

Change subpaths in one place and all four follow. Change them anywhere else and they
silently disagree.

## 3. Per-request: the proxy chain

`proxy.ts` composes ordered middleware. Order is load-bearing:

```
withAuth → withMakeswift → withLocaleAliases → withIntl → withAnalyticsCookies
         → withChannelId → withGraphqlProxy → withRoutes
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

- `next.config.ts` resolution · `generateStaticParams` · API routes · proxies
- `lib/kv/keys.ts` — default KV cache namespace
- `auth/index.ts` — when a JWT carries no `channel_id`

**Gotcha:** if your default *region* isn't the channel in `BIGCOMMERCE_CHANNEL_ID`,
"unresolved locale" silently means a different channel than "default locale" does.
Pick one and know which paths use which. *This repo avoids it:* the config channel
(`BIGCOMMERCE_CHANNEL_ID`) is NZ `1889993` and its default language is `en-NZ`, so
schema generation, the build-time `SettingsQuery`, the `/` redirect, sitemap, robots,
favicon and every fallback above all mean NZ. The build-config `vanityUrl` (used for
login and wishlist redirects) is NZ's too.

**Single-channel by design:** `sitemap.xml`, `robots.txt` and `favicon.ico` routes all
call `getChannelIdFromLocale(defaultLocale)` — they reflect the default region only.
Multi-region sitemaps need work. `checkout/route.ts` *is* channel-aware; each channel
has its own checkout URL.

**Canonical/hreflang hosts are per channel.** `lib/seo/canonical.ts` builds absolute URLs
from the *requesting* channel's site URL, so `/au/*` pages emit `store-…-1889990…` hosts and
`/nz/*` pages emit `store-…-1889993…` hosts — even for their hreflang alternates. With one
app on one domain, both channels' site URLs (or the canonical base) must resolve to that
domain. Unresolved in this repo.

## 5. Gotchas that cost real time

**Set each language's subfolder path in the control panel, on the config channel.**
`i18n/locales.ts` only assigns a prefix `if (locale.path)`, so an empty path means
next-intl silently uses the raw locale code as the segment (`/en-AU`, not `/au`), and
also changes who owns `/` (§7). The GraphQL Admin API's `addLocale`/`updateLocale` have
**no path field** — the control panel is the place. Verify what Catalyst will see before
restarting dev or deploying:

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

**Every served locale needs `messages/{locale}.json`.** `i18n/request.ts` hard-imports
it and throws if absent; it also `notFound()`s any locale not in `locales`. For a region
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

`computeRootLocale()` in `i18n/locales.ts` decides who owns `/`:

1. Default locale has no path → it lives at `/`.
2. Else if exactly one non-default locale has no path → that one lives at `/`.
3. Otherwise → **nobody**; next-intl switches to `always` mode and every locale is
   prefixed.

Under rule 3, `/` stops being a page and becomes a **redirect**. Three viable shapes:

| Shape | `/` behaviour | Trade-off |
| :-- | :-- | :-- |
| **A.** Default region at `/`, others prefixed | renders the default region | Stock Catalyst, zero extra code. But `/` *is* a storefront, so geo-redirecting away from it means discarding a rendered page. |
| **B.** All regions prefixed, nothing at `/` | redirects | Clean dispatcher, ideal for a geo/chooser step. Requires `computeRootLocale` to return `null`, and `/` never renders content. |
| **C.** Neutral locale at `/`, regions prefixed alongside | renders a neutral variant | Both `/au` and `/nz` are real URLs *and* `/` still renders. Costs an extra locale, and `/` duplicates a region's content until a dispatcher replaces it. |

*This repo uses B:* every region is prefixed and `/` only redirects. Both config-channel
languages have a path, so stock `computeRootLocale` returns `null` and next-intl runs in
`always` mode — no app code needed. The redirect target is whatever next-intl resolves —
`NEXT_LOCALE` cookie, then `Accept-Language`, then the BigCommerce default (`en-NZ` →
`/nz`). A geolocation or region-chooser step can replace that resolution later without
touching the locale model. `en` is not a BigCommerce language; it remains the message
fallback (`messages/en.json`) only.

**Known rough edge under B:** next-intl's own `Link` response header advertises
`hreflang="x-default"` at the *unprefixed* URL, which now redirects. The page-level
metadata from `lib/seo/canonical.ts` correctly points `x-default` at the default region
(`/nz/...`). Either disable `alternateLinks` in `i18n/routing.ts` or accept the redirecting
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
| `i18n/locales.ts` | derives `locales`, `defaultLocale`, `prefixes`, `rootLocale` |
| `i18n/routing.ts` | next-intl routing config, prefix mode |
| `i18n/request.ts` | per-locale message loading |
| `proxy.ts` + `proxies/*` | ordered request pipeline |
| `proxies/with-makeswift.ts` | flags builder requests, disables locale detection for them |
| `proxies/with-locale-aliases.ts` | `/en-AU/...` → `/au/...` (rewrite for builder, 308 for public) |
| `proxies/with-channel-id.ts` | sets `x-bc-channel-id` |
| `proxies/with-routes.ts` | per-channel slug resolution |
| `client/index.ts` | channel-aware GraphQL client |
| `lib/seo/canonical.ts` | canonical + hreflang |
| `lib/makeswift/client.ts` | Makeswift locale normalization |
| `build-config/` | build-time settings snapshot |

## 9. References

- [Catalyst Multi-Storefront: overview](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-storefront) · [setup](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-storefront/setup)
- [Catalyst multi-language setup](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/multi-language/setup) · [static translations](https://developer.bigcommerce.com/docs/storefront/catalyst/features/localization/static-translations)
- [Locales configuration (GraphQL Admin API)](https://developer.bigcommerce.com/docs/store-operations/settings/locales) — add/update/delete locales per channel
- [MSF international enhancements](https://developer.bigcommerce.com/docs/store-operations/catalog/msf-international-enhancements/overview) — translating catalog data
- [Multi-storefront overview](https://developer.bigcommerce.com/docs/storefront/multi-storefront)
- [next-intl routing & middleware](https://next-intl.dev/docs/routing) — prefix modes, locale detection
- [Google: managing multi-regional and multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites)
