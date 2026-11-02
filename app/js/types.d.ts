// The browser as this site uses it, for the type check (jsconfig.json).
// Not loaded by the site.

// Events here always come from elements.
interface EventTarget { closest(selectors: string): HTMLElement | null; }
interface Element { dataset: DOMStringMap; }

interface Window {
  google: any; // Google Identity Services, loaded by drive.js
  webkitAudioContext: typeof AudioContext; // older Safari
}

// Safari: lets the timer sound play while the phone is on silent.
interface Navigator { audioSession?: { type: string }; }
