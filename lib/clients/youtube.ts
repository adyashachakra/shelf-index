import 'server-only';
import { config } from '../config';
import { isTimeoutError, logEvent } from '../log';

// Official YouTube Data API v3 client (read-only, public data, plain HTTPS).
// The API key travels as the documented "key" query parameter, so request URLs are never logged.

const BASE = 'https://www.googleapis.com/youtube/v3';

export type YouTubeErrorKind =
  | 'quota'
  | 'comments_disabled'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'unavailable'
  | 'timeout'
  | 'network';

export class YouTubeError extends Error {
  kind: YouTubeErrorKind;
  constructor(kind: YouTubeErrorKind, message: string) {
    super(message);
    this.name = 'YouTubeError';
    this.kind = kind;
  }
}

export interface YtVideo {
  id: string;
  title: string;
  description: string;
  channel: string;
  /** YouTube's own "includes paid promotion" flag. null when the API did not report it. */
  paidPlacement: boolean | null;
  commentCount: number | null;
}

export interface YtComment {
  id: string;
  videoId: string;
  text: string;
  likeCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function get(path: string, query: Record<string, string>): Promise<unknown> {
  const apiKey = config.youtubeApiKey();
  if (!apiKey) throw new YouTubeError('auth', 'YOUTUBE_API_KEY is not set');
  const search = new URLSearchParams({ ...query, key: apiKey });
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}?${search.toString()}`, {
      signal: AbortSignal.timeout(12_000),
      cache: 'no-store',
    });
  } catch (err) {
    // Deliberately no URL in this message: the URL contains the key.
    throw new YouTubeError(isTimeoutError(err) ? 'timeout' : 'network', 'Could not reach the YouTube API');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.ok) return json;

  let reason = '';
  if (isRecord(json) && isRecord(json.error) && Array.isArray(json.error.errors)) {
    const first = json.error.errors[0];
    if (isRecord(first) && typeof first.reason === 'string') reason = first.reason;
  }
  let kind: YouTubeErrorKind;
  if (['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(reason)) kind = 'quota';
  else if (reason === 'commentsDisabled') kind = 'comments_disabled';
  else if (reason === 'videoNotFound' || res.status === 404) kind = 'not_found';
  else if (res.status === 400) kind = reason === 'keyInvalid' ? 'auth' : 'bad_request';
  else if (res.status === 401 || res.status === 403) kind = 'auth';
  else kind = 'unavailable';
  logEvent('youtube_error', { kind, status: res.status, reason });
  throw new YouTubeError(kind, `YouTube API error (${reason || res.status})`);
}

/** One search call. Returns video ids with snippet text. */
export async function searchVideos(query: string, maxResults: number): Promise<YtVideo[]> {
  const json = await get('search', {
    part: 'snippet',
    type: 'video',
    q: query.slice(0, 200),
    maxResults: String(Math.max(1, Math.min(15, maxResults))),
    order: 'relevance',
    relevanceLanguage: 'en',
    safeSearch: 'moderate',
  });
  const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
  const videos: YtVideo[] = [];
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.id) || typeof item.id.videoId !== 'string') continue;
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    videos.push({
      id: item.id.videoId,
      title: decodeEntities(typeof snippet.title === 'string' ? snippet.title : ''),
      description: decodeEntities(typeof snippet.description === 'string' ? snippet.description : ''),
      channel: decodeEntities(typeof snippet.channelTitle === 'string' ? snippet.channelTitle : ''),
      paidPlacement: null,
      commentCount: null,
    });
  }
  return videos;
}

/** Full descriptions, comment counts and the paid-promotion flag for up to 50 videos (1 quota unit). */
export async function getVideoDetails(ids: string[]): Promise<YtVideo[]> {
  if (ids.length === 0) return [];
  let json: unknown;
  try {
    json = await get('videos', { part: 'snippet,statistics,paidProductPlacementDetails', id: ids.join(',') });
  } catch (err) {
    if (err instanceof YouTubeError && err.kind === 'bad_request') {
      json = await get('videos', { part: 'snippet,statistics', id: ids.join(',') });
    } else {
      throw err;
    }
  }
  const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
  const videos: YtVideo[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const snippet = isRecord(item.snippet) ? item.snippet : {};
    const stats = isRecord(item.statistics) ? item.statistics : {};
    const paid = isRecord(item.paidProductPlacementDetails) ? item.paidProductPlacementDetails : null;
    const commentCount = typeof stats.commentCount === 'string' ? Number.parseInt(stats.commentCount, 10) : NaN;
    videos.push({
      id: item.id,
      title: typeof snippet.title === 'string' ? snippet.title : '',
      description: typeof snippet.description === 'string' ? snippet.description : '',
      channel: typeof snippet.channelTitle === 'string' ? snippet.channelTitle : '',
      paidPlacement: paid && typeof paid.hasPaidProductPlacement === 'boolean' ? paid.hasPaidProductPlacement : null,
      commentCount: Number.isFinite(commentCount) ? commentCount : null,
    });
  }
  return videos;
}

/** Top-level public comments for one video, most relevant first (1 quota unit). Author names are not kept. */
export async function getTopComments(videoId: string, maxResults: number): Promise<YtComment[]> {
  const json = await get('commentThreads', {
    part: 'snippet',
    videoId,
    maxResults: String(Math.max(1, Math.min(100, maxResults))),
    order: 'relevance',
    textFormat: 'plainText',
  });
  const items = isRecord(json) && Array.isArray(json.items) ? json.items : [];
  const comments: YtComment[] = [];
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.snippet)) continue;
    const top = isRecord(item.snippet.topLevelComment) ? item.snippet.topLevelComment : null;
    const snippet = top && isRecord(top.snippet) ? top.snippet : null;
    if (!top || !snippet || typeof top.id !== 'string') continue;
    const text = typeof snippet.textDisplay === 'string' ? snippet.textDisplay : '';
    comments.push({
      id: top.id,
      videoId,
      text,
      likeCount: typeof snippet.likeCount === 'number' ? snippet.likeCount : 0,
    });
  }
  return comments;
}
