// The key used to compare note titles: case-insensitive for every alphabet, and Unicode-normalised.
export const titleKey = (title) => String(title).normalize('NFC').trim().toLowerCase();
