const test = async (url) => {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "MarketPulseAI/1.0 (contact: your-email@example.com)" } });
    console.log(url, "->", res.status);
  } catch (e) {
    console.log(url, "-> ERROR", e.message);
  }
};
["https://www.marketwatch.com/rss/topstories", "https://www.cnbc.com/id/100003114/device/rss/rss.html"].forEach(test);

