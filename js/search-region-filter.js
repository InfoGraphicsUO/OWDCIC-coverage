// the location search box only limits suggestions to the Oregon and Washington
// data area, which still overlaps Idaho and California, so drop suggestions
// outside Oregon and Washington from the response
(() => {
  const REGION_CODES = ['OR', 'WA'];
  const REGION_NAMES = ['Oregon', 'Washington'];
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    const url = input?.url ?? String(input);
    if (!url.includes('/search/searchbox/v1/suggest')) return response;

    const data = await response.clone().json();
    data.suggestions = data.suggestions?.filter((suggestion) => (
      REGION_CODES.includes(suggestion.context?.region?.region_code)
      || (suggestion.feature_type === 'region' && REGION_NAMES.includes(suggestion.name))
    ));
    return new Response(JSON.stringify(data), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
})();
