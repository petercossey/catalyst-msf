'use server';

import { revalidateTag } from 'next/cache';

import { getChannelIdFromLocale } from '~/channels.config';
import { client } from '~/client';
import { graphql } from '~/client/graphql';
import { TAGS } from '~/client/tags';
import { getCartId } from '~/lib/cart';
import { getCurrentChannelId } from '~/lib/channel';

const UpdateCartLocaleMutation = graphql(`
  mutation UpdateCartLocaleMutation($input: UpdateCartLocaleInput!) {
    cart {
      updateCartLocale(input: $input) {
        cart {
          entityId
        }
        errors {
          __typename
          ... on Error {
            message
          }
        }
      }
    }
  }
`);

// Keeps the cart's locale in sync when the shopper switches their storefront
// locale. Unlike currency, updating the locale mutates the cart in place, so the
// cart ID does not change. This is best-effort: a failure here should not block
// the locale navigation, so errors are logged rather than surfaced to the user.
export const switchLocale = async (locale: string): Promise<void> => {
  // A locale on another channel means a different cart (see `~/lib/cart`), and that channel
  // may not support this cart's locale. The target channel's own cart needs no update.
  if (getChannelIdFromLocale(locale) !== (await getCurrentChannelId())) {
    return;
  }

  const cartId = await getCartId();

  if (!cartId) {
    return;
  }

  try {
    const result = await client.fetch({
      document: UpdateCartLocaleMutation,
      variables: { input: { cartEntityId: cartId, data: { locale } } },
    });

    const updateCartLocale = result.data.cart.updateCartLocale;

    // `updateCartLocale` is null when the feature is disabled for this store.
    if (!updateCartLocale) {
      return;
    }

    const { errors } = updateCartLocale;

    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.error('Error updating cart locale', errors);

      return;
    }

    revalidateTag(TAGS.cart, { expire: 0 });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Error updating cart locale', error);
  }
};
