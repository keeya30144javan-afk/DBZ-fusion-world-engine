/** Game plans of strong players' decks (data/visions.json), bundled into the page. */
export interface Vision { name: string; plan: string; engines: string[] }
export interface Visions { about: string; principles: string[]; decks: Record<string, Vision> }

declare const __BUNDLED_VISIONS__: Visions;

export const VISIONS: Visions = typeof __BUNDLED_VISIONS__ !== 'undefined' ? __BUNDLED_VISIONS__ : { about: '', principles: [], decks: {} };
