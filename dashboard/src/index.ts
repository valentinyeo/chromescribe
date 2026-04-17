/**
 * ChromeScribe Dashboard - Cloudflare Worker
 * YouTube Transcription with Cloudflare AI
 */

interface Env {
  DB: D1Database;
  TRANSCRIPTS: R2Bucket;
  AI: Ai;
}

interface Transcript {
  id: number;
  video_id: string;
  title: string;
  channel: string;
  duration: number;
  srt_path: string;
  created_at: string;
  word_count: number;
  thumbnail_url: string;
  category: string | null;
  tags: string | null;
}

interface WhisperResponse {
  text: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
  }>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface ParsedVideo {
  platform: 'youtube' | 'tiktok' | 'article';
  id: string;
  prefixedId: string;
}

// Stable 8-char hex hash (djb2) so the same article URL always maps to the same video_id
const hashUrl = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
};

const parseVideoUrl = (url: string): ParsedVideo | null => {
  // YouTube
  const ytMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return { platform: 'youtube', id: ytMatch[1], prefixedId: ytMatch[1] };

  // TikTok
  const ttMatch = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  if (ttMatch) return { platform: 'tiktok', id: ttMatch[1], prefixedId: `tiktok:${ttMatch[1]}` };

  // Article — any other http(s) URL
  if (/^https?:\/\//i.test(url)) {
    const id = hashUrl(url);
    return { platform: 'article', id, prefixedId: `article:${id}` };
  }

  return null;
};

const getThumbnailUrl = (parsed: ParsedVideo, noembedThumbnail?: string): string | null => {
  if (parsed.platform === 'youtube') {
    return `https://img.youtube.com/vi/${parsed.id}/mqdefault.jpg`;
  }
  // For TikTok, use oEmbed thumbnail or fallback to placeholder
  return noembedThumbnail || null;
};

const formatDuration = (seconds: number): string => {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

const handleError = (error: any, status = 500): Response => {
  console.error('API Error:', error);
  return new Response(
    JSON.stringify({ success: false, error: error.message || 'Internal error' }),
    { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
  );
};

const jsonResponse = (data: any, status = 200): Response => {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
};

// Note: YouTube blocks Cloudflare IPs, so we use a hybrid approach:
// 1. Extension downloads audio locally with yt-dlp
// 2. Uploads audio to Worker
// 3. Worker transcribes with Cloudflare AI Whisper
// 4. Saves transcript to R2 + D1


// Convert Whisper transcript to SRT format
function whisperToSRT(segments: WhisperResponse['segments']): string {
  if (!segments) return '';
  
  let srt = '';
  segments.forEach((seg, i) => {
    const start = formatSRTTime(seg.start);
    const end = formatSRTTime(seg.end);
    srt += `${i + 1}\n${start} --> ${end}\n${seg.text.trim()}\n\n`;
  });
  return srt;
}

function formatSRTTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

// API Routes
const handleApi = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace('/api/', '');

  try {
    // GET /api/debug - Debug endpoint
    if (request.method === 'GET' && path === 'debug') {
      return jsonResponse({
        message: 'Debug endpoint working',
        ai_binding: typeof env.AI !== 'undefined',
      });
    }

    // GET /api/thumb/:video_id - Cached thumbnail proxy
    if (request.method === 'GET' && path.startsWith('thumb/')) {
      const videoId = decodeURIComponent(path.replace('thumb/', ''));
      const r2Key = `thumbs/${videoId.replace(/[^a-zA-Z0-9_:-]/g, '_')}.jpg`;

      // Check R2 cache first
      const cached = await env.TRANSCRIPTS.get(r2Key);
      if (cached) {
        return new Response(cached.body, {
          headers: {
            'Content-Type': cached.httpMetadata?.contentType || 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
            'CDN-Cache-Control': 'public, max-age=31536000, immutable',
            ...CORS_HEADERS,
          },
        });
      }

      // Resolve source URL
      let sourceUrl: string | null = null;
      if (videoId.startsWith('tiktok:')) {
        // Look up thumbnail_url from DB for TikTok
        const row = await env.DB
          .prepare('SELECT thumbnail_url FROM transcripts WHERE video_id = ?')
          .bind(videoId)
          .first<{ thumbnail_url: string }>();
        sourceUrl = row?.thumbnail_url || null;
      } else {
        sourceUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
      }

      if (!sourceUrl) {
        return new Response('Not found', { status: 404, headers: CORS_HEADERS });
      }

      // Fetch, cache in R2, serve
      try {
        const imgRes = await fetch(sourceUrl);
        if (!imgRes.ok) throw new Error('Fetch failed');
        const imgData = await imgRes.arrayBuffer();
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

        await env.TRANSCRIPTS.put(r2Key, imgData, {
          httpMetadata: { contentType },
        });

        return new Response(imgData, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'CDN-Cache-Control': 'public, max-age=31536000, immutable',
            ...CORS_HEADERS,
          },
        });
      } catch {
        return new Response('Not found', { status: 404, headers: CORS_HEADERS });
      }
    }

    // GET /api/channels - List monitored YouTube channels
    // `name` is the canonical channel name as stored in transcripts.channel
    // (frontend prefix-matches against this so historical name variants still hit)
    if (request.method === 'GET' && path === 'channels') {
      const channels = [
        { id: 'UCctL30i8tVgSS9A37Q532eg', handle: '@Incomestreamsurfers', name: 'Income stream surfers' },
        { id: 'UCPjNBjflYl0-HQtUvOx0Ibw', handle: '@GregIsenberg', name: 'Greg Isenberg' },
        { id: 'UC2ojq-nuP8ceeHqiroeKhBA', handle: '@nateherk', name: 'Nate Herk | AI Automation' },
        { id: 'UC6t1O76G0jYXOAoYCm153dA', handle: '@LennysPodcast', name: "Lenny's Podcast" },
        { id: 'UC2WmuBuFq6gL08QYG-JjXKw', handle: '@intheworldofai', name: 'WorldofAI' },
        { id: 'UCoy6cTJ7Tg0dqS-DI-_REsA', handle: '@Chase-H-AI', name: 'Chase AI' },
        { id: 'UC0m81bQuthaQZmFbXEY9QSw', handle: '@AICodeKing', name: 'AICodeKing' },
        { id: 'UCUyeluBRhGPCW4rPe_UvBZQ', handle: '@ThePrimeTimeagen', name: 'The PrimeTime' },
        { id: 'UCbDmEdLs-SB3FjrDFQJ4TDg', handle: '@reysu', name: 'Reysu' },
        { id: 'UCmL7cQmNgV-3FxaB3Ueoixg', handle: '@claudelog', name: 'Claude Code Updates' },
      ];
      return jsonResponse(channels);
    }

    // GET /api/categories - List distinct categories with counts
    if (request.method === 'GET' && path === 'categories') {
      const { results } = await env.DB
        .prepare("SELECT category, COUNT(*) as count FROM transcripts WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY count DESC")
        .all<{ category: string; count: number }>();
      return jsonResponse(results);
    }

    // GET /api/transcripts - List all transcripts
    if (request.method === 'GET' && (path === 'transcripts' || path === '')) {
      const { results } = await env.DB
        .prepare('SELECT * FROM transcripts ORDER BY created_at DESC')
        .all<Transcript>();
      
      return jsonResponse(results.map(t => ({
        ...t,
        duration_formatted: formatDuration(t.duration),
        created_at_formatted: new Date(t.created_at).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit'
        })
      })));
    }

    // GET /api/transcripts/:id - Get single transcript
    if (request.method === 'GET' && path.startsWith('transcripts/')) {
      const parts = path.split('/');
      if (parts.length === 2) {
        const id = parts[1];
        const result = await env.DB
          .prepare('SELECT * FROM transcripts WHERE id = ?')
          .bind(id)
          .first<Transcript>();
        
        if (!result) {
          return handleError(new Error('Transcript not found'), 404);
        }
        return jsonResponse(result);
      }
    }

    // GET /api/transcript/:id/content - Get transcript content
    if (request.method === 'GET' && path.startsWith('transcript/') && path.endsWith('/content')) {
      const parts = path.split('/');
      const id = parts[1];
      const result = await env.DB
        .prepare('SELECT srt_path FROM transcripts WHERE id = ?')
        .bind(id)
        .first<{ srt_path: string }>();
      
      if (!result) {
        return handleError(new Error('Transcript not found'), 404);
      }

      const content = await env.TRANSCRIPTS.get(result.srt_path);
      if (!content) {
        return handleError(new Error('Content file not found'), 404);
      }

      return new Response(content.body, {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // POST /api/whisper - Raw transcription only, returns text (no DB storage)
    // Used by monitor.sh for chunked transcription of large files
    if (request.method === 'POST' && path === 'whisper') {
      const formData = await request.formData();
      const audioField = formData.get('audio') as File;
      if (!audioField || audioField.size === 0) {
        return handleError(new Error('Audio file is required'), 400);
      }
      const audioBuffer = await audioField.arrayBuffer();
      try {
        const result = await env.AI.run('@cf/openai/whisper', {
          audio: Array.from(new Uint8Array(audioBuffer)),
        }) as WhisperResponse;
        return jsonResponse({ text: result.text });
      } catch (e: any) {
        return handleError(new Error(`Whisper failed: ${e.message}`), 500);
      }
    }

    // POST /api/transcribe - Two modes:
    // 1. With url only: Use YouTube URL (if supported)
    // 2. With audio: Upload audio file for transcription
    if (request.method === 'POST' && path === 'transcribe') {
      const contentType = request.headers.get('content-type') || '';
      
      // Mode 1: JSON with URL (for local download flow)
      if (contentType.includes('application/json')) {
        const body = await request.json();
        const { url: videoUrl, title, srt_content, markdown_content } = body;

        if (!videoUrl) {
          return handleError(new Error('URL is required'), 400);
        }

        const parsed = parseVideoUrl(videoUrl);
        if (!parsed) {
          return handleError(new Error('Unsupported video URL'), 400);
        }

        const videoId = parsed.prefixedId;

        // Check for duplicate — return existing transcript info
        const existing = await env.DB
          .prepare('SELECT id, title FROM transcripts WHERE video_id = ?')
          .bind(videoId)
          .first<{ id: number; title: string }>();

        if (existing) {
          return jsonResponse({
            id: existing.id,
            video_id: videoId,
            title: existing.title,
            already_exists: true,
            view_url: `https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/transcript.html?id=${existing.id}`,
            message: `Already transcribed: "${existing.title}". Delete it first to retranscribe.`,
          }, 200);
        }

        // If markdown content provided (from local transcription), save it
        if (markdown_content) {
          const wordCount = markdown_content.split(/\s+/).filter(w => w.length > 0).length;

          // Extract title from markdown content if title looks like a file name
          const mdTitleMatch = markdown_content.match(/^#\s+(.+)$/m);
          let mdTitle = mdTitleMatch ? mdTitleMatch[1].trim() : null;

          const srtPath = `content/${parsed.id}.md`;
          await env.TRANSCRIPTS.put(srtPath, markdown_content);

          // Get video info if available
          let videoTitle = title || mdTitle || `Video ${parsed.id}`;
          let videoChannel =
            parsed.platform === 'tiktok' ? 'TikTok' :
            parsed.platform === 'article' ? 'Article' : 'YouTube';
          let noembedThumbnail: string | undefined;

          try {
            if (parsed.platform === 'article') {
              // Article — channel = domain, title from markdown
              try {
                videoChannel = new URL(videoUrl).hostname.replace(/^www\./, '');
              } catch {}
              videoTitle = mdTitle || title || videoTitle;
            } else if (parsed.platform === 'tiktok') {
              // Use TikTok's oEmbed API
              const infoRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`);
              if (infoRes.ok) {
                const info = await infoRes.json() as any;
                videoTitle = info.title || videoTitle;
                videoChannel = info.author_name || videoChannel;
                noembedThumbnail = info.thumbnail_url;
              }
            } else {
              // Use noembed for YouTube
              const infoRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`);
              if (infoRes.ok) {
                const info = await infoRes.json() as any;
                if (!info.error) {
                  // Only use noembed title if our title is a file name
                  if (!mdTitle || title) {
                    videoTitle = info.title || videoTitle;
                  }
                  videoChannel = info.author_name || videoChannel;
                  noembedThumbnail = info.thumbnail_url;
                }
              }
            }
          } catch (e) {}

          const result = await env.DB
            .prepare(`
              INSERT INTO transcripts (video_id, title, channel, duration, srt_path, word_count, thumbnail_url)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              videoId,
              videoTitle,
              videoChannel,
              Math.round(wordCount / 2.5),
              srtPath,
              wordCount,
              getThumbnailUrl(parsed, noembedThumbnail)
            )
            .run();

          const transcriptId = result.meta?.last_row_id;
          return jsonResponse({
            id: transcriptId,
            video_id: videoId,
            title: videoTitle,
            view_url: `https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/transcript.html?id=${transcriptId}`,
          }, 201);
        }

        // If only URL provided, return instructions for local download
        return jsonResponse({
          video_id: videoId,
          message: 'Download locally with yt-dlp and upload the audio.',
          instructions: {
            step1: `yt-dlp -x --audio-format mp3 -o "audio.mp3" "${videoUrl}"`,
            step2: 'Upload the audio file to /api/upload for transcription',
          }
        });
      }

      // Mode 2: multipart/form-data with audio file
      if (contentType.includes('multipart/form-data')) {
        let formData;
        try {
          formData = await request.formData();
        } catch (e: any) {
          return handleError(new Error(`FormData parsing failed: ${e.message}`), 400);
        }
        
        const audioField = formData.get('audio');
        const videoUrlField = formData.get('url');
        const titleField = formData.get('title');
        
        console.log('audioField:', audioField);
        console.log('audioField type:', typeof audioField);
        console.log('audioField constructor:', audioField?.constructor?.name);
        console.log('audioField instanceof File:', audioField instanceof File);
        
        // Check if audioField is valid
        if (!audioField) {
          return handleError(new Error('Audio file is required'), 400);
        }
        
        // audioField should be an object (File is an object)
        if (typeof audioField !== 'object') {
          return handleError(new Error(`Audio data must be an object, got: ${typeof audioField}`), 400);
        }
        
        // In Workers, formData returns File objects
        const audioFile = audioField as File;
        
        if (audioFile.size === 0) {
          return handleError(new Error('Audio file is empty'), 400);
        }
        
        const audioData = audioField as File;
        const videoUrl = videoUrlField ? String(videoUrlField) : '';
        const title = titleField ? String(titleField) : 'Untitled';
        
        // Get video ID or generate one if URL is unrecognized
        let videoId: string;
        let parsedUpload: ParsedVideo | null = null;
        if (videoUrl) {
          parsedUpload = parseVideoUrl(videoUrl);
          videoId = parsedUpload ? parsedUpload.prefixedId : `audio-${Date.now()}`;
        } else {
          videoId = `audio-${Date.now()}`;
        }
        console.log('Video ID:', videoId);

        if (!audioData) {
          return handleError(new Error('Audio file required'), 400);
        }

        // Handle both File objects and string data
        let audioBuffer: ArrayBuffer;
        if (typeof audioData === 'string') {
          // Convert base64 string to ArrayBuffer
          const binary = atob(audioData);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          audioBuffer = bytes.buffer;
        } else {
          audioBuffer = await (audioData as File).arrayBuffer();
        }

        // Check duplicate — return existing transcript info
        console.log('Checking duplicate for videoId:', videoId);
        if (videoId && !videoId.startsWith('audio-')) {
          const existing = await env.DB
            .prepare('SELECT id, title FROM transcripts WHERE video_id = ?')
            .bind(videoId)
            .first<{ id: number; title: string }>();
          if (existing) {
            return jsonResponse({
              id: existing.id,
              video_id: videoId,
              title: existing.title,
              already_exists: true,
              view_url: `https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/transcript.html?id=${existing.id}`,
              message: `Already transcribed: "${existing.title}". Delete it first to retranscribe.`,
            }, 200);
          }
        }
        console.log('No duplicate found, proceeding with transcription');

        // Transcribe with Workers AI
        console.log(`Transcribing audio with Cloudflare AI, buffer size: ${audioBuffer.byteLength}`);
        let transcript: WhisperResponse;
        try {
          transcript = await env.AI.run('@cf/openai/whisper', {
            audio: Array.from(new Uint8Array(audioBuffer)),
          }) as WhisperResponse;
          console.log('Transcription complete, text length:', transcript.text?.length);
        } catch (e: any) {
          console.error('Transcription error:', e);
          return handleError(new Error(`Transcription failed: ${e.message}`), 500);
        }

        // Generate markdown
        const wordCount = transcript.text.split(/\s+/).filter(w => w.length > 0).length;
        const srtContent = whisperToSRT(transcript.segments);
        
        const markdownContent = `# ${title}

**Source:** ${videoUrl || 'Audio upload'}
**Date:** ${new Date().toISOString().split('T')[0]}
**Type:** Video Transcription

---

## Full Transcript

${srtContent || transcript.text}

---

*Transcribed with Cloudflare Workers AI*
`;

        // Save to R2
        const srtPath = `content/${parsedUpload ? parsedUpload.id : videoId}.md`;
        await env.TRANSCRIPTS.put(srtPath, markdownContent);

        // Get video info
        let videoTitle = title;
        let videoChannel = parsedUpload?.platform === 'tiktok' ? 'TikTok' : 'YouTube';
        let noembedThumb: string | undefined;

        if (videoUrl) {
          try {
            if (parsedUpload?.platform === 'tiktok') {
              // Use TikTok's oEmbed API
              const infoRes = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`);
              if (infoRes.ok) {
                const info = await infoRes.json() as any;
                videoTitle = info.title || videoTitle;
                videoChannel = info.author_name || videoChannel;
                noembedThumb = info.thumbnail_url;
              }
            } else {
              // Use noembed for YouTube
              const infoRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`);
              if (infoRes.ok) {
                const info = await infoRes.json() as any;
                if (!info.error) {
                  videoTitle = info.title || videoTitle;
                  videoChannel = info.author_name || videoChannel;
                  noembedThumb = info.thumbnail_url;
                }
              }
            }
          } catch (e) {
            console.log('Failed to get video info:', e);
          }
        }

        // Save metadata to D1
        const thumbnailUrl = parsedUpload
          ? getThumbnailUrl(parsedUpload, noembedThumb)
          : null;
        const result = await env.DB
          .prepare(`
            INSERT INTO transcripts (video_id, title, channel, duration, srt_path, word_count, thumbnail_url)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            videoId,
            videoTitle,
            videoChannel,
            Math.round(wordCount / 2.5),
            srtPath,
            wordCount,
            thumbnailUrl
          )
          .run();

        const transcriptId = result.meta?.last_row_id;
        return jsonResponse({
          id: transcriptId,
          video_id: videoId,
          title: videoTitle,
          channel: videoChannel,
          word_count: wordCount,
          transcript_preview: transcript.text.substring(0, 500),
          view_url: `https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/transcript.html?id=${transcriptId}`,
        }, 201);
      }

      return handleError(new Error('Invalid request'), 400);
    }

    // DELETE /api/transcripts/:id - Delete transcript
    if (request.method === 'DELETE' && path.startsWith('transcripts/')) {
      const parts = path.split('/');
      if (parts.length === 2) {
        const id = parts[1];
        
        const transcript = await env.DB
          .prepare('SELECT srt_path FROM transcripts WHERE id = ?')
          .bind(id)
          .first<{ srt_path: string }>();

        if (!transcript) {
          return handleError(new Error('Transcript not found'), 404);
        }

        await env.TRANSCRIPTS.delete(transcript.srt_path);

        await env.DB
          .prepare('DELETE FROM transcripts WHERE id = ?')
          .bind(id)
          .run();

        return jsonResponse({ deleted: true });
      }
    }

    // PUT /api/transcripts/:id - Update transcript content and title
    if (request.method === 'PUT' && path.startsWith('transcripts/')) {
      const parts = path.split('/');
      if (parts.length === 2) {
        const id = parts[1];

        const existing = await env.DB
          .prepare('SELECT srt_path, video_id FROM transcripts WHERE id = ?')
          .bind(id)
          .first<{ srt_path: string; video_id: string }>();

        if (!existing) {
          return handleError(new Error('Transcript not found'), 404);
        }

        const body = await request.json() as any;
        const { markdown_content, title, category, tags } = body;

        if (markdown_content) {
          await env.TRANSCRIPTS.put(existing.srt_path, markdown_content);
          const wordCount = markdown_content.split(/\s+/).filter((w: string) => w.length > 0).length;
          await env.DB
            .prepare('UPDATE transcripts SET word_count = ? WHERE id = ?')
            .bind(wordCount, id)
            .run();
        }

        if (title) {
          await env.DB
            .prepare('UPDATE transcripts SET title = ? WHERE id = ?')
            .bind(title, id)
            .run();
        }

        if (category !== undefined) {
          await env.DB
            .prepare('UPDATE transcripts SET category = ? WHERE id = ?')
            .bind(category, id)
            .run();
        }

        if (tags !== undefined) {
          const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : tags;
          await env.DB
            .prepare('UPDATE transcripts SET tags = ? WHERE id = ?')
            .bind(tagsJson, id)
            .run();
        }

        return jsonResponse({ id, updated: true });
      }
    }

    // Search transcripts
    if (request.method === 'GET' && path === 'search') {
      const query = url.searchParams.get('q') || '';
      
      if (!query) {
        return handleError(new Error('Search query required'), 400);
      }

      const { results } = await env.DB
        .prepare(`
          SELECT * FROM transcripts 
          WHERE title LIKE ? OR channel LIKE ? OR video_id LIKE ?
          ORDER BY created_at DESC
        `)
        .bind(`%${query}%`, `%${query}%`, `%${query}%`)
        .all<Transcript>();

      return jsonResponse(results);
    }

    return handleError(new Error('Endpoint not found'), 404);

  } catch (error: any) {
    return handleError(error);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // API routes
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }

    // CSP header to allow API calls even when embedded in YouTube iframe
    const CSP_HEADER = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; frame-src https: data:; connect-src 'self' https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev https://*.youtube.com https://img.youtube.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;";

    const HTML_HEADERS = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP_HEADER,
    };

    // Serve HTML pages
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const object = await env.TRANSCRIPTS.get('index.html');
      if (object) {
        return new Response(object.body, {
          headers: HTML_HEADERS,
        });
      }
    }

    if (url.pathname === '/transcript.html') {
      const object = await env.TRANSCRIPTS.get('transcript.html');
      if (object) {
        return new Response(object.body, {
          headers: HTML_HEADERS,
        });
      }
    }

    if (url.pathname === '/settings.html') {
      const object = await env.TRANSCRIPTS.get('settings.html');
      if (object) {
        return new Response(object.body, {
          headers: HTML_HEADERS,
        });
      }
    }

    // Serve debug page
    if (url.pathname === '/debug.html') {
      const object = await env.TRANSCRIPTS.get('debug.html');
      if (object) {
        return new Response(object.body, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    // Static assets
    const staticFile = await env.TRANSCRIPTS.get(url.pathname.slice(1));
    if (staticFile) {
      const ext = url.pathname.split('.').pop();
      const contentTypes: Record<string, string> = {
        'css': 'text/css',
        'js': 'application/javascript',
        'json': 'application/json',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'svg': 'image/svg+xml',
        'ico': 'image/x-icon',
      };
      return new Response(staticFile.body, {
        headers: { 'Content-Type': contentTypes[ext || ''] || 'text/plain' },
      });
    }

    return new Response('Not found', { status: 404 });
  }
};
