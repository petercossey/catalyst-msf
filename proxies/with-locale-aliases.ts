import { unstable_isDraftModeRequest } from '@makeswift/runtime/next/middleware';
import { NextRequest, NextResponse } from 'next/server';

import { getLocaleRoutingForProxy } from '~/i18n/locale-config';
import { LocaleRouting } from '~/i18n/locale-routing';

import { type ProxyFactory } from './compose-proxies';

// Locales whose public URL prefix differs from their raw code, e.g. `en-AU` → `/au`.
// The raw code (`/en-AU`) is accepted as an alias for the real prefix.
const getAliases = ({ locales, prefixes }: LocaleRouting) =>
  locales.flatMap((locale) => {
    const prefix = prefixes[locale];

    if (!prefix || prefix.toLowerCase() === `/${locale.toLowerCase()}`) return [];

    return [{ alias: `/${locale.toLowerCase()}`, prefix }];
  });

const resolveAlias = (pathname: string, aliases: ReturnType<typeof getAliases>) => {
  const lower = pathname.toLowerCase();
  const match = aliases.find(({ alias }) => lower === alias || lower.startsWith(`${alias}/`));

  if (!match) return null;

  return `${match.prefix}${pathname.slice(match.alias.length)}`;
};

// The Makeswift builder ignores our custom regional prefixes and always previews
// pages at `/{localeCode}/...` (`/en-AU/shop-all`). Map those URLs onto the real
// prefixes from the BigCommerce locale routing (`~/i18n/locale-config`):
//
// - Builder (draft-mode) requests are rewritten in place, so the iframe URL the
//   builder chose keeps working without a redirect.
// - Everything else gets a permanent redirect to the canonical prefixed URL, so
//   `/en-AU/...` never becomes a second public URL for the same page.
//
// Must run before `withIntl`, which is what interprets the prefix.
export const withLocaleAliases: ProxyFactory = (next) => {
  return async (request, event) => {
    // Same KV-cached lookup `withIntl` makes next. When it's unavailable, `withIntl` answers 503.
    const localeRouting = await getLocaleRoutingForProxy(event);

    if (!localeRouting) {
      return next(request, event);
    }

    const aliased = resolveAlias(request.nextUrl.pathname, getAliases(localeRouting));

    if (aliased === null) {
      return next(request, event);
    }

    const url = request.nextUrl.clone();

    url.pathname = aliased;

    if (unstable_isDraftModeRequest(request)) {
      return next(new NextRequest(url, request), event);
    }

    return NextResponse.redirect(url, 308);
  };
};
