// newsFetcher.js
const Parser = require('rss-parser');

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
});

const RSS_FEEDS = [
  { name: 'MarketWatch', url: 'https://www.marketwatch.com/rss/topstories' },
  { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedrender?source=cnbcnews&titles=true&trend=true&partnerId=2000&issue=true' },
  { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' }
];

async function fetchAllSources() {
  const allArticles = [];
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

  for (const feed of RSS_FEEDS) {
    try {
      const parsedFeed = await parser.parseURL(feed.url);
      for (const item of parsedFeed.items) {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
        if (pubDate >= thirtyMinutesAgo) {
          const dedupeKey = item.guid || item.link || item.title;
          allArticles.push({
            _dedupeKey: dedupeKey,
            text: item.title,
            url: item.link || '',
            source: feed.name,
            category: 'General'
          });
        }
      }
    } catch (err) {
      console.warn(`[NewsFetcher] Warning: failed to fetch ${feed.url}: ${err.message}`);
    }
  }

  return allArticles;
}

module.exports = { fetchAllSources };
