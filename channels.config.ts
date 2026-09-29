// Set overrides per locale
// Each locale here must be a language (with its subfolder path) on the config
// channel, `BIGCOMMERCE_CHANNEL_ID` (NZ, 1889993). Every locale has a path, so
// none lives at the bare "/" URL: it redirects to a region prefix.
const localeToChannelsMappings: Record<string, string> = {
  'en-AU': '1889990',
  'en-NZ': '1889993',
};

function getChannelIdFromLocale(locale = '') {
  return localeToChannelsMappings[locale] ?? process.env.BIGCOMMERCE_CHANNEL_ID;
}

export { getChannelIdFromLocale };
