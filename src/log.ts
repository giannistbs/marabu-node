
export function log(message: string): void {
    const date = new Date();
    const date_iso = date.toISOString();
    console.log(`${date_iso} ${message}`);
}

export function warn(message: string): void {
    const date = new Date();
    const date_iso = date.toISOString();
    console.warn(`${date_iso} ${message}`);
}

export function error(message: string): void {
    const date = new Date();
    const date_iso = date.toISOString();
    console.error(`${date_iso} ${message}`);
}