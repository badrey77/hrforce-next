import { escape } from './html.js';
export const page = (name: string): string => `<p>${escape(name)}</p>`;
