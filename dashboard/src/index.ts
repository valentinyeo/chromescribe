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
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const getVideoId = (url: string): string | null => {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
};

const getYouTubeThumbnail = (videoId: string): string => {
  return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
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

    // GET /api/transcripts - List all transcripts
    if (request.method === 'GET' && (path === 'transcripts' || path === '')) {
      const { results } = await env.DB
        .prepare('SELECT * FROM transcripts ORDER BY created_at DESC')
        .all<Transcript>();
      
      return jsonResponse(results.map(t => ({
        ...t,
        duration_formatted: formatDuration(t.duration),
        created_at_formatted: new Date(t.created_at).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric'
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

        const videoId = getVideoId(videoUrl);
        if (!videoId) {
          return handleError(new Error('Invalid YouTube URL'), 400);
        }

        // Check for duplicate
        const existing = await env.DB
          .prepare('SELECT id FROM transcripts WHERE video_id = ?')
          .bind(videoId)
          .first();

        if (existing) {
          return handleError(new Error('Video already transcribed'), 409);
        }

        // If markdown content provided (from local transcription), save it
        if (markdown_content) {
          const wordCount = markdown_content.split(/\s+/).filter(w => w.length > 0).length;
          
          const srtPath = `content/${videoId}.md`;
          await env.TRANSCRIPTS.put(srtPath, markdown_content);

          // Get video info if available
          let videoTitle = title || `Video ${videoId}`;
          let videoChannel = 'YouTube';
          
          try {
            const infoRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`);
            if (infoRes.ok) {
              const info = await infoRes.json();
              if (!info.error) {
                videoTitle = info.title || videoTitle;
                videoChannel = info.author_name || videoChannel;
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
              getYouTubeThumbnail(videoId)
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

        // If only URL provided, try YouTube download (may fail due to CF restrictions)
        // Return instructions for local download
        return jsonResponse({
          video_id: videoId,
          message: 'YouTube is blocked from Cloudflare Workers. Please download locally with yt-dlp and upload the audio.',
          instructions: {
            step1: `yt-dlp -x --audio-format mp3 -o "audio.mp3" ${videoUrl}`,
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
        
        // Get video ID or generate one if YouTube URL is invalid
        let videoId: string;
        if (videoUrl) {
          const extractedId = getVideoId(videoUrl);
          videoId = extractedId || `audio-${Date.now()}`;
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

        // Check duplicate
        console.log('Checking duplicate for videoId:', videoId);
        if (videoId && !videoId.startsWith('audio-')) {
          const existing = await env.DB
            .prepare('SELECT id FROM transcripts WHERE video_id = ?')
            .bind(videoId)
            .first();
          if (existing) {
            return handleError(new Error('Video already transcribed'), 409);
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
        const srtPath = `content/${videoId}.md`;
        await env.TRANSCRIPTS.put(srtPath, markdownContent);

        // Get video info if YouTube URL provided
        let videoTitle = title;
        let videoChannel = 'YouTube';
        
        if (videoUrl) {
          try {
            const infoRes = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(videoUrl)}`);
            if (infoRes.ok) {
              const info = await infoRes.json();
              if (!info.error) {
                videoTitle = info.title || videoTitle;
                videoChannel = info.author_name || videoChannel;
              }
            }
          } catch (e) {
            console.log('Failed to get video info:', e);
          }
        }

        // Save metadata to D1
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
            videoId.includes('-') ? null : getYouTubeThumbnail(videoId)
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
    const CSP_HEADER = "default-src 'self'; script-src 'self' 'unsafe-inline' https://www.youtube.com; frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev https://*.youtube.com https://img.youtube.com; img-src 'self' data: https://img.youtube.com; style-src 'self' 'unsafe-inline';";

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
