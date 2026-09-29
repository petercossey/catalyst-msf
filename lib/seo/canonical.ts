import { buildConfig } from '~/build-config/reader';
import { getLocaleRouting } from '~/i18n/locale-config';
import { getLocalePrefix, LocaleRouting } from '~/i18n/locale-routing';

interface CanonicalUrlOptions {
  /**
   * The path from BigCommerce (e.g., product.path, category.path)
   * or a manually constructed path for static pages (e.g., '/')
   */
  path: string;
  /**
   * Current locale from params
   */
  locale: string;
  /**
   * Whether to include hreflang alternates for all locales
   * @default true
   */
  includeAlternates?: boolean;
}

/**
 * Generates metadata alternates object for Next.js Metadata API
 *
 * Rules:
 * - Default locale: no prefix (e.g., https://example.com/product/)
 * - Other locales: with prefix (e.g., https://example.com/fr/product/)
 * - Respects TRAILING_SLASH environment variable
 *
 * @param {CanonicalUrlOptions} options - The options for generating canonical URLs
 * @returns {object} The metadata alternates object with canonical URL and optional language alternates
 */
export async function getMetadataAlternates(options: CanonicalUrlOptions) {
  const { path, locale, includeAlternates = true } = options;

  const baseUrl = getSiteBaseUrl();

  // Subfolders are merchant-configured and read at runtime, so canonical and hreflang URLs stay
  // correct without a redeploy — and stay in agreement with what the proxy resolves.
  const localeRouting = await getLocaleRouting();

  const canonical = buildLocalizedUrl(baseUrl, path, locale, localeRouting);

  if (!includeAlternates) {
    return { canonical };
  }

  const languages = localeRouting.locales.reduce<Record<string, string>>((acc, loc) => {
    acc[loc] = buildLocalizedUrl(baseUrl, path, loc, localeRouting);

    return acc;
  }, {});

  languages['x-default'] = buildLocalizedUrl(
    baseUrl,
    path,
    localeRouting.defaultLocale,
    localeRouting,
  );

  return { canonical, languages };
}

/**
 * The single origin that absolute URLs (canonical, hreflang, og:url) are built on.
 *
 * All channels are served from one domain, so this is the config channel's site URL
 * (`BIGCOMMERCE_CHANNEL_ID`, from the build-time snapshot) rather than the requesting
 * channel's. BigCommerce won't let two channels share a site URL, so the other
 * channels' URLs are redirect-only hosts; using them would make canonicals point at
 * a redirect and hreflang alternates disagree between regions. Preview deployments
 * use their own URL instead.
 *
 * @returns {string} The absolute origin to build canonical and alternate URLs on
 */
export function getSiteBaseUrl(): string {
  const previewUrl =
    process.env.VERCEL_ENV === 'preview' ? `https://${process.env.VERCEL_URL}` : undefined;

  if (previewUrl && URL.canParse(previewUrl)) return previewUrl;

  return buildConfig.get('urls').vanityUrl;
}

function buildLocalizedUrl(
  baseUrl: string,
  pathname: string,
  locale: string,
  localeRouting: LocaleRouting,
): string {
  const trailingSlash = process.env.TRAILING_SLASH !== 'false';

  const url = new URL(pathname, baseUrl);

  // Empty for the locale served unprefixed at "/".
  const prefix = getLocalePrefix(localeRouting, locale);

  url.pathname = `${prefix}${url.pathname}`;

  if (trailingSlash && !url.pathname.endsWith('/')) {
    url.pathname += '/';
  } else if (!trailingSlash && url.pathname.endsWith('/') && url.pathname !== '/') {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}
