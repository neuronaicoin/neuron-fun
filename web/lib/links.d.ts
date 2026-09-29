type Clean = { value: string | null; ok: boolean };
export function cleanX(v: string | null | undefined): Clean;
export function cleanTelegram(v: string | null | undefined): Clean;
export function cleanWebsite(v: string | null | undefined): Clean;
export function xUrl(h: string): string;
export function telegramUrl(t: string): string;
