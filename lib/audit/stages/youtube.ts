import 'server-only';
import { getTopComments, getVideoDetails, searchVideos, YouTubeError, type YtVideo } from '../../clients/youtube';
import { config } from '../../config';
import { brandAttribution, mentionsBrand } from '../../evidence/brand-match';
import { clean, clip } from '../../evidence/normalize';
import { detectSponsorship } from '../../evidence/sponsorship';
import { addSetAside } from '../../evidence/identity';
import type { EvidenceItem, SetAsideEvidence } from '../../types';
import { mixedNameReason, similarNameReason } from '../evidence-builders';
import type { StageContext } from '../context';
import type { YouTubeData } from '../job';

const MAX_VIDEOS = 4;
const COMMENTS_PER_VIDEO = 8;

function describeFailure(err: YouTubeError): string {
  if (err.kind === 'quota') return "YouTube's free daily quota is used up";
  if (err.kind === 'auth') return 'the YouTube API key was not accepted';
  return 'the YouTube API could not be reached';
}

/**
 * Stage 5: sample public YouTube videos about the brand and a few top comments on each,
 * through the official YouTube Data API only. YouTube is optional: if it is unavailable,
 * comments are disabled or nothing relevant exists, the audit continues without it.
 */
export async function runYouTube(ctx: StageContext): Promise<'done' | 'continue'> {
  if (ctx.data.youtube) return 'done';
  const { meta } = ctx;

  if (!config.youtubeApiKey()) {
    await ctx.save('youtube', { status: 'skipped', note: 'No YouTube API key is configured.', videos: [], comments: [] });
    ctx.warn('YouTube was skipped because no YouTube API key is configured.');
    ctx.note('youtube', 'Skipped');
    return 'done';
  }

  const result: YouTubeData = { status: 'ok', videos: [], comments: [] };
  try {
    const found = await searchVideos(`${meta.brand} ${meta.categoryNoun} review`, 10);
    // A video counts only if it names the brand itself, not a similar name ("COS RX" is not "COS"), and does not
    // also name a look-alike ("COS to COSRX"): such a video is unverified, so neither it nor its comments are used.
    const setAside: SetAsideEvidence[] = [];
    result.setAside = setAside;
    const isClear = (v: YtVideo): boolean => {
      const text = `${v.title} ${v.description}`;
      return mentionsBrand(text, meta.brand) && brandAttribution(text, meta.brand).state !== 'mixed';
    };
    for (const v of found) {
      if (isClear(v)) continue;
      const reason = similarNameReason(`${v.title} ${v.description}`, 'youtube.com', meta.brand);
      if (reason !== null) addSetAside(setAside, { title: clip(clean(v.title), 120), url: `https://www.youtube.com/watch?v=${v.id}`, domain: 'youtube.com', reason });
    }
    let relevant: YtVideo[] = found.filter(isClear).slice(0, MAX_VIDEOS);

    if (relevant.length > 0) {
      try {
        const details = await getVideoDetails(relevant.map((v) => v.id));
        const byId = new Map(details.map((d) => [d.id, d]));
        relevant = relevant.map((v) => byId.get(v.id) ?? v);
      } catch (err) {
        if (err instanceof YouTubeError && err.kind === 'quota') throw err;
        // Details are a refinement (full description, paid-promotion flag); the search snippet is enough to continue.
      }
    }

    let disabled = 0;
    for (const [index, video] of relevant.entries()) {
      const url = `https://www.youtube.com/watch?v=${video.id}`;
      const signals = detectSponsorship(`${video.title} ${video.description}`, video.paidPlacement);
      result.videos.push({
        id: `V${index + 1}`,
        kind: 'youtube_video',
        url,
        domain: 'youtube.com',
        title: clip(clean(video.title), 160),
        text: clip(clean(`${video.title}. ${video.description}`), 700),
        sourceUrl: url,
        channel: clip(clean(video.channel), 80),
        ...(signals.length > 0 ? { sponsored: signals } : {}),
      });

      try {
        const comments = await getTopComments(video.id, 40);
        const seen = new Set<string>();
        const picked = comments
          .map((c) => ({ ...c, text: clean(c.text) }))
          .filter((c) => c.text.length >= 30 && c.text.length <= 700 && !/https?:\/\//i.test(c.text))
          .filter((c) => {
            // A comment that names the brand together with a look-alike cannot be attributed to the brand.
            const attribution = brandAttribution(c.text, meta.brand);
            if (attribution.state !== 'mixed') return true;
            addSetAside(setAside, { title: clip(`Comment on "${clean(video.title)}"`, 120), url: `${url}&lc=${encodeURIComponent(c.id)}`, domain: 'youtube.com', reason: mixedNameReason(meta.brand, attribution.lookalikes) });
            return false;
          })
          .filter((c) => {
            const key = c.text.toLowerCase().slice(0, 80);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort((a, b) => b.likeCount - a.likeCount)
          .slice(0, COMMENTS_PER_VIDEO);
        for (const comment of picked) {
          const item: EvidenceItem = {
            id: `C${result.comments.length + 1}`,
            kind: 'youtube_comment',
            url: `${url}&lc=${encodeURIComponent(comment.id)}`,
            domain: 'youtube.com',
            title: clip(`Comment on "${clean(video.title)}"`, 160),
            text: clip(comment.text, 500),
            sourceUrl: url,
            likeCount: comment.likeCount,
          };
          result.comments.push(item);
        }
      } catch (err) {
        if (!(err instanceof YouTubeError)) throw err;
        if (err.kind === 'comments_disabled') {
          disabled += 1;
        } else if (err.kind === 'quota') {
          result.status = 'partial';
          result.note = "YouTube's free daily quota ran out part-way through, so only some comments were sampled.";
          break;
        } else {
          result.status = 'partial';
          result.note = 'Comments could not be loaded for every video.';
        }
      }
    }

    if (relevant.length === 0) {
      result.note = 'No YouTube videos naming the brand were found.';
    } else if (disabled > 0 && !result.note) {
      result.note = `Comments are turned off on ${disabled} of the ${relevant.length} videos.`;
      if (result.comments.length === 0) result.status = 'partial';
    }
  } catch (err) {
    if (!(err instanceof YouTubeError)) throw err;
    result.status = result.videos.length > 0 ? 'partial' : 'unavailable';
    result.note = `YouTube was not available: ${describeFailure(err)}.`;
  }

  if (result.status === 'unavailable' || result.status === 'partial') {
    ctx.warn(result.note ?? 'YouTube data is incomplete for this audit.');
  }
  if (result.setAside && result.setAside.length === 0) delete result.setAside;
  await ctx.save('youtube', result);
  ctx.note(
    'youtube',
    result.status === 'unavailable'
      ? 'Unavailable, continuing without YouTube'
      : `${result.videos.length} video${result.videos.length === 1 ? '' : 's'}, ${result.comments.length} comment${result.comments.length === 1 ? '' : 's'} sampled`,
  );
  return 'done';
}
