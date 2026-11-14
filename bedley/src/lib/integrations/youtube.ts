export interface Video {
  id: string;
  title: string;
  channel: string;
  thumbnail: string;
  url: string;
}

/** YouTube Data API v3 search. Real videos only — returns [] when no key is set (never invents links). */
export async function searchVideos(query: string, max = 3): Promise<{ ok: boolean; videos: Video[]; error?: string }> {
  const key = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, videos: [], error: "YOUTUBE_API_KEY not set" };
  try {
    const u = new URL("https://www.googleapis.com/youtube/v3/search");
    u.searchParams.set("part", "snippet");
    u.searchParams.set("type", "video");
    u.searchParams.set("maxResults", String(max));
    u.searchParams.set("safeSearch", "strict");
    u.searchParams.set("relevanceLanguage", "en");
    u.searchParams.set("q", query);
    u.searchParams.set("key", key);
    const res = await fetch(u);
    if (!res.ok) return { ok: false, videos: [], error: `YouTube API ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const data = (await res.json()) as { items?: Array<any> };
    const videos = (data.items || [])
      .filter((i) => i.id?.videoId)
      .map((i) => ({
        id: i.id.videoId,
        title: decode(i.snippet.title),
        channel: i.snippet.channelTitle,
        thumbnail: i.snippet.thumbnails?.medium?.url || i.snippet.thumbnails?.default?.url,
        url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
      }));
    return { ok: true, videos };
  } catch (e) {
    return { ok: false, videos: [], error: (e as Error).message };
  }
}

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
