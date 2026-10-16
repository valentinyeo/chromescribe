
const fs = require('fs');
const path = require('path');
const https = require('https');

const API_URL = 'https://chromescribe-dashboard.ancient-glitter-9ac9.workers.dev/api/transcribe';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

function post(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractSourceUrl(content) {
  const match = content.match(/\*\*Source:\*\*\s*(https?:\/\/[^\s\n]+)/i);
  return match ? match[1] : null;
}

function extractTitle(content) {
  const match = content.match(/^#\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

function extractDate(content) {
  const match = content.match(/\*\*Date:\*\*\s*(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

async function importFile(filePath) {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, 'utf-8');
  
  const url = extractSourceUrl(content);
  const title = extractTitle(content);
  const date = extractDate(content);
  
  if (!url) {
    console.log(`⏭️  Skipping ${filename} - no Source URL found`);
    return { file: filename, status: 'skipped', reason: 'no URL' };
  }
  
  let videoId = null;
  const ytMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) {
    videoId = ytMatch[1];
  } else {
    const ttMatch = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
    if (ttMatch) videoId = `tiktok:${ttMatch[1]}`;
  }

  let channel = url.includes('tiktok.com') ? 'TikTok' : 'YouTube';
  const channelMatch = content.match(/\*\*Channel:\*\*\s*(.+)/i);
  if (channelMatch) channel = channelMatch[1].trim();
  
  console.log(`📤 Uploading: ${title || filename}`);
  console.log(`   URL: ${url}`);
  console.log(`   Video ID: ${videoId || 'N/A'}`);
  
  try {
    const result = await post(API_URL, {
      url,
      title: title || filename.replace('.md', ''),
      channel,
      markdown_content: content
    });
    
    if (result.success) {
      console.log(`   ✅ Done! ID: ${result.data.id}`);
      console.log(`   🔗 ${result.data.view_url}`);
      return { file: filename, status: 'success', id: result.data.id };
    } else {
      console.log(`   ❌ Error: ${result.error}`);
      return { file: filename, status: 'error', error: result.error };
    }
  } catch (err) {
    console.log(`   ❌ Failed: ${err.message}`);
    return { file: filename, status: 'failed', error: err.message };
  }
}

async function main() {
  console.log('🚀 ChromeScribe Dashboard Importer\n');
  console.log('=' .repeat(50));
  
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(OUTPUT_DIR, f))
    .sort();
  
  console.log(`Found ${files.length} markdown files\n`);
  
  const results = [];
  
  for (const file of files) {
    const result = await importFile(file);
    results.push(result);
    console.log('');
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log('\n' + '=' .repeat(50));
  console.log('\n📊 Summary:');
  console.log(`   Total: ${results.length}`);
  console.log(`   Success: ${results.filter(r => r.status === 'success').length}`);
  console.log(`   Skipped: ${results.filter(r => r.status === 'skipped').length}`);
  console.log(`   Failed: ${results.filter(r => r.status === 'error' || r.status === 'failed').length}`);
  
  const summaryPath = path.join(__dirname, 'import-results.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 Results saved to: ${summaryPath}`);
}

main().catch(console.error);
