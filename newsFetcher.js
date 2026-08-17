import Parser from 'rss-parser';

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
});

const RSS_FEEDS = [
  'https://www.marketwatch.com/rss/topstories',
  'https://search.cnbc.com/rs/search/combinedrender?source=cnbcnews&titles=true&trend=true&partnerId=2000&issue=true',
  'https://finance.yahoo.com/news/rssindex'
];

export async function fetchLatestNews() {
  const allArticles = [];
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;

  for (const feedUrl of RSS_FEEDS) {
    try {
      const feed = await parser.parseURL(feedUrl);
      for (const item of feed.items) {
        const pubDate = item.pubDate ? new Date(item.pubDate).getTime() : Date.now();
        if (pubDate >= thirtyMinutesAgo) {
          allArticles.push({
            id: item.guid || item.link || item.title,
            title: item.title,
            link: item.link,
            pubDate: pubDate
          });
        }
      }
    } catch (err) {
      console.warn(`[NewsFetcher] Warning: failed to fetch ${feedUrl}: ${err.message}`);
    }
  }

  return allArticles;
}