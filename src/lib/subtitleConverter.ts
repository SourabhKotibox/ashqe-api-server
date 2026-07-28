import fs from 'fs';
import path from 'path';

/** Convert SubRip (.srt) text to WebVTT for HTML5 <track> support. */
export function srtToVtt(srt: string): string {
  let body = srt.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  // Timecode: 00:00:00,000 --> 00:00:00,000  →  use dots
  body = body.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  // Drop numeric cue indexes (lines that are only digits)
  body = body
    .split('\n')
    .filter((line) => !/^\d+$/.test(line.trim()))
    .join('\n');
  return `WEBVTT\n\n${body}\n`;
}

/**
 * If path is .srt, write a sibling .vtt and return the .vtt relative /uploads path.
 * Otherwise return the original path.
 */
export function ensureVttSubtitle(absolutePath: string, relativeUploadsPath: string): string {
  const ext = path.extname(absolutePath).toLowerCase();
  if (ext !== '.srt') return relativeUploadsPath;

  const raw = fs.readFileSync(absolutePath, 'utf8');
  const vtt = srtToVtt(raw);
  const vttAbs = absolutePath.replace(/\.srt$/i, '.vtt');
  fs.writeFileSync(vttAbs, vtt, 'utf8');

  return relativeUploadsPath.replace(/\.srt$/i, '.vtt');
}

export function isSubtitleFile(fileName: string, mimeType = ''): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return ['.srt', '.vtt', '.ass', '.ssa'].includes(ext) ||
    mimeType.includes('subrip') ||
    mimeType.includes('vtt') ||
    mimeType === 'text/plain';
}
