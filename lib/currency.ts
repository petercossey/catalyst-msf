'use server';

import { cookies } from 'next/headers';
import { cache } from 'react';

import { client } from '~/client';
import { graphql } from '~/client/graphql';
import { revalidate } from '~/client/revalidate-target';
import type { CurrencyCode } from '~/components/header/fragment';
import { CurrencyCodeSchema } from '~/components/header/schema';
import { hasConsentFor } from '~/lib/consent-manager/has-consent-for';

const ChannelCurrenciesQuery = graphql(`
  query ChannelCurrenciesQuery {
    site {
      settings {
        currency {
          defaultCurrency
        }
      }
      currencies(first: 25) {
        edges {
          node {
            code
            isTransactional
          }
        }
      }
    }
  }
`);

// Currencies of the channel serving this request (`~/client` resolves it from the locale).
const getChannelCurrencies = cache(async () => {
  const { data } = await client.fetch({
    document: ChannelCurrenciesQuery,
    fetchOptions: { next: { revalidate } },
  });

  return {
    defaultCurrency: data.site.settings?.currency.defaultCurrency,
    transactionalCurrencies: data.site.currencies.edges
      ?.filter(({ node }) => node.isTransactional)
      .map(({ node }) => node.code),
  };
});

/**
 * The currency to price, search and create carts in for this request.
 *
 * Storefront GraphQL falls back to the *store's* default currency when a request names none,
 * even on a channel that doesn't enable it. With one currency per channel (e.g. AU = AUD,
 * NZ = NZD) that prices one region in the other's currency and makes cart creation fail with
 * "Currency not found". So when the shopper hasn't chosen a currency this channel offers, fall
 * back to the channel's own default rather than leaving it unset.
 *
 * @returns {Promise<CurrencyCode | undefined>} The currency code, or `undefined` if the channel
 *   settings can't be read and no usable cookie is set.
 */
export async function getPreferredCurrencyCode(): Promise<CurrencyCode | undefined> {
  const cookieStore = await cookies();
  const result = CurrencyCodeSchema.safeParse(cookieStore.get('currencyCode')?.value);
  const cookieCurrency = result.success ? result.data : undefined;

  try {
    const { defaultCurrency, transactionalCurrencies } = await getChannelCurrencies();

    // The cookie is domain-wide, so a choice made in one region can reach another.
    if (cookieCurrency && transactionalCurrencies?.includes(cookieCurrency)) {
      return cookieCurrency;
    }

    return defaultCurrency;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Unable to read channel currencies', error);

    return cookieCurrency;
  }
}

export async function setPreferredCurrencyCode(currencyCode: CurrencyCode): Promise<void> {
  // The currency preference is a functionality cookie; without consent the
  // selected currency still applies to the cart but the preference isn't stored.
  if (!(await hasConsentFor('functionality'))) {
    return;
  }

  const cookieStore = await cookies();

  cookieStore.set('currencyCode', currencyCode, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}
