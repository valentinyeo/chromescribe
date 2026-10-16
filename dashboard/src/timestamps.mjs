export function addEstimatedTimestamps(text, duration, videoId) {
  if (videoId.startsWith('article:') || !Number.isFinite(duration) || duration <= 0) return text;
  const words = [...text.matchAll(/\S+/g)];
  if (!words.length) return text;

  const markers = new Map();
  for (let target = 0; target < duration; target += 30) {
    const index = Math.round(target / duration * words.length);
    if (index >= words.length || markers.has(index)) continue;
    const seconds = Math.floor(index / words.length * duration);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    const tail = String(seconds % 60).padStart(2, '0');
    markers.set(index, hours
      ? `[${hours}:${String(minutes).padStart(2, '0')}:${tail}]`
      : `[${minutes}:${tail}]`);
  }

  let index = 0;
  return text.replace(/\S+/g, word => {
    const marker = markers.get(index++);
    return marker ? `${marker} ${word}` : word;
  });
}
