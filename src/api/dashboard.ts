import fs from 'node:fs';

const readStatic = (filename: string): string =>
  fs.readFileSync(new URL(`./static/${filename}`, import.meta.url), 'utf8');

export const dashboardHtml = (): string =>
  readStatic('dashboard.html')
    .replace('{{STYLE}}', readStatic('dashboard.css'))
    .replace('{{SCRIPT}}', readStatic('dashboard.js'));
