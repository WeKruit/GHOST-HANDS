import type { GhostHandsAPI } from '../main/preload';

declare global {
  interface Window {
    ghosthands: GhostHandsAPI;
  }
}
